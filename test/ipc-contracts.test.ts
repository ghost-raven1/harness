import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { serve, rpc, rpcRaw, socketPath } from '../src/interfaces/ipc.js';
import { createAccessToken } from '../src/interfaces/local-channel.js';
import {
  commands,
  parseCommandInput,
  parseCommandResponse,
  type CommandResponse,
} from '../src/interfaces/contracts/index.js';
import { applicationIdentity } from '../src/shared/identity.js';
import { ApplicationError } from '../src/shared/application-error.js';
import { serviceCompatibility } from '../src/interfaces/service-compatibility.js';
import { explainError } from '../src/interfaces/guided/errors.js';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  close: vi.fn(async () => undefined),
  start: vi.fn(),
}));
vi.mock('../src/interfaces/application.js', () => ({
  createApplication: async () => ({
    runtime: { close: mocks.close },
    learning: { start: mocks.start },
    close: mocks.close,
  }),
}));
vi.mock('../src/interfaces/routes.js', () => ({ dispatch: mocks.dispatch }));
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  for (const remove of cleanup.splice(0).reverse()) await remove();
});

/** Каждая проверка владеет отдельным сокетом и не открывает историю пользователя. */
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'harness-contract-'));
  cleanup.push(() => rm(value, { recursive: true, force: true }));
  return value;
}

it('тип ответа выводится из имени команды, неизвестные поля и неверные вложения отклоняются', () => {
  expectTypeOf<CommandResponse<'runtime.cancel'>>().toEqualTypeOf<{ cancelled: true }>();
  expectTypeOf<CommandResponse<'runtime.message'>['status']>().toEqualTypeOf<
    'queued' | 'delivered'
  >();
  expect(() => parseCommandInput('runtime.cancel', { runId: randomUUID(), allow: true })).toThrow(
    ApplicationError,
  );
  expect(() =>
    parseCommandResponse('learning.inspect', { candidate: { id: 'x' }, evidence: [] }),
  ).toThrow(ApplicationError);
  expect(() => parseCommandResponse('approvals.list', [{ id: 'x', status: 'allowed' }])).toThrow(
    ApplicationError,
  );
  expect(parseCommandInput('runtime.history', {})).toEqual({
    query: '',
    page: 0,
    limit: 10,
    includeDeleted: false,
  });
  expect(Object.keys(commands)).toContain('diagnostics.verifyHistory');
});

it('старый клиент без версии выполняет команду, неизвестная версия не доходит до обработчика', async () => {
  const state = await directory();
  const service = await serve('unused', state);
  cleanup.push(() => service.close());
  mocks.dispatch.mockResolvedValue({ cancelled: true });
  const input = { runId: randomUUID() };
  await expect(rpcRaw(state, 'runtime.cancel', input, null)).resolves.toEqual({ cancelled: true });
  await expect(rpcRaw(state, 'runtime.cancel', input, 1)).resolves.toEqual({ cancelled: true });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  await expect(rpcRaw(state, 'runtime.cancel', input, 2)).rejects.toMatchObject({
    code: 'INCOMPATIBLE_PROTOCOL',
  });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
  await expect(rpcRaw(state, 'runtime.cancel', { runId: 'invalid' }, null)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  expect(mocks.dispatch).toHaveBeenCalledTimes(2);
});

it('проверяет контракт ответа на сервере и передаёт код ошибки клиенту', async () => {
  const state = await directory();
  const service = await serve('unused', state);
  cleanup.push(() => service.close());
  mocks.dispatch.mockResolvedValue({ cancelled: 'yes' });
  await expect(rpc(state, 'runtime.cancel', { runId: randomUUID() })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
  mocks.dispatch.mockRejectedValue(new ApplicationError('UNKNOWN_OUTCOME', 'Проверьте действие.'));
  await expect(rpc(state, 'runtime.resume', { runId: randomUUID() })).rejects.toMatchObject({
    code: 'UNKNOWN_OUTCOME',
  });
});

it('клиент самостоятельно отклоняет неправильный ответ старого или повреждённого сервиса', async () => {
  const state = await directory();
  await createAccessToken(state);
  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]!);
      socket.end(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { cancelled: false } }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath(state), resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(rpc(state, 'runtime.cancel', { runId: randomUUID() })).rejects.toMatchObject({
    code: 'INVALID_RESPONSE',
  });
});

it('метаданные прежнего протокола допустимы, различие сборок показывается без остановки', () => {
  const local = applicationIdentity();
  const service = {
    ...local,
    node: process.version,
    state: '/fixture',
    workspaces: [],
    defaultProfile: 'test',
    tools: [],
    profiles: [],
  };
  const {
    buildId: _buildId,
    protocolVersion: _protocol,
    storageVersion: _storage,
    capabilities: _capabilities,
    ...legacy
  } = service;
  expect(parseCommandResponse('system.info', legacy).version).toBe(local.version);
  expect(serviceCompatibility(service)).toBeUndefined();
  expect(
    serviceCompatibility(
      { ...service, buildId: 'b'.repeat(64) },
      { ...local, buildId: 'a'.repeat(64) },
    ),
  ).toContain('Задачи продолжают работать');
  expect(
    serviceCompatibility({ ...service, version: '0.2.1' }, { ...local, version: '0.3.0' }),
  ).toContain('CLI 0.3.0, сервис 0.2.1');
  expect(explainError(new ApplicationError('STALE_PREVIEW', 'arbitrary text'))).toContain(
    'предпросмотр',
  );
});

it('новый CLI присоединяется к строгому конверту сервиса 0.2.x без перезапуска задач', async () => {
  const state = await directory();
  await createAccessToken(state);
  const oldInfo = {
    version: '0.2.1',
    node: process.version,
    state,
    workspaces: [],
    defaultProfile: 'test',
    tools: [],
    profiles: [],
    activeRuns: 1,
  };
  const frames: unknown[] = [];
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      frames.push(request);
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: oldInfo }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath(state), resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(rpc(state, 'system.info')).resolves.toMatchObject({
    version: '0.2.1',
    activeRuns: 1,
  });
  expect(
    Object.keys(frames[0] as object)
      .filter((key) => key !== 'token')
      .sort(),
  ).toEqual(['id', 'jsonrpc', 'method', 'params']);
  expect(frames).toHaveLength(1);
});
