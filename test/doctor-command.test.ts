import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerDoctorCommand, showDiagnostics } from '../src/interfaces/commands/doctor.js';
import { FileSessionStore } from '../src/sessions/store.js';
import type { CliContext } from '../src/interfaces/types.js';
import type { HistoryVerificationReport } from '../src/diagnostics/history-types.js';
import { temporary } from './helpers.js';

const owner = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock('../src/interfaces/ipc.js', () => ({ acquireLock: owner.acquire }));
vi.mock('../src/interfaces/diagnostics.js', () => ({
  diagnose: vi.fn(async () => ({
    ready: false,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    state: '/PRIVATE/state',
    endpoint: '/PRIVATE/channel',
    transport: 'unix-socket',
    checks: [{ name: 'Конфигурация', status: 'pass', detail: '/PRIVATE/config' }],
    profiles: [],
  })),
}));

const history: HistoryVerificationReport = {
  checkedAt: new Date().toISOString(),
  healthy: true,
  readOnly: false,
  counts: { journals: 0, records: 0, runs: 0, outputs: 0, learning: 0, unresolvedOperations: 0 },
  issues: [],
};

/** Создаёт локальный клиент без терминала и без работающего демона. */
function context(directory: string, request = vi.fn()): CliContext {
  return {
    directory: () => directory,
    json: () => true,
    interactive: () => false,
    output: vi.fn(),
    request: request as CliContext['request'],
  };
}

beforeEach(() => {
  process.exitCode = undefined;
  owner.acquire.mockReset().mockResolvedValue(owner.release);
  owner.release.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

it('регистрирует все флаги и отправляет проверку действующему владельцу', async () => {
  const client = context(await temporary(), vi.fn().mockResolvedValue(history));
  const program = new Command();
  registerDoctorCommand(program, client);
  expect(program.commands[0]?.options.map((option) => option.long)).toEqual([
    '--config',
    '--verify-history',
    '--rebuild-index',
    '--export',
  ]);
  await program.parseAsync(['doctor', '--verify-history'], { from: 'user' });
  expect(client.request).toHaveBeenCalledWith('diagnostics.verifyHistory', {});
  expect(owner.acquire).not.toHaveBeenCalled();
  expect(client.output).toHaveBeenCalledWith(expect.objectContaining({ history }));
  expect(process.exitCode).toBeUndefined();
});

it('без сервиса проверяет историю под блокировкой и затем освобождает её', async () => {
  const directory = await temporary();
  const client = context(
    directory,
    vi.fn().mockRejectedValue(new Error('Local service unavailable. Run harness serve first.')),
  );
  await showDiagnostics(client, undefined, { verifyHistory: true });
  expect(owner.acquire).toHaveBeenCalledWith(directory);
  expect(owner.release).toHaveBeenCalledOnce();
  expect(client.output).toHaveBeenCalledWith(
    expect.objectContaining({ history: expect.objectContaining({ healthy: true }) }),
  );
});

it('ошибка работающего владельца не запускает второе обслуживание файлов', async () => {
  const problem = Object.assign(new Error('Диск отказал'), { code: 'STORAGE_UNAVAILABLE' });
  const client = context(await temporary(), vi.fn().mockRejectedValue(problem));
  await expect(showDiagnostics(client, undefined, { verifyHistory: true })).rejects.toBe(problem);
  expect(owner.acquire).not.toHaveBeenCalled();
});

it('offline перестроение явно отключает восстановление исполнителей и хвостов', async () => {
  const client = context(
    await temporary(),
    vi.fn().mockRejectedValue(new Error('Local service unavailable.')),
  );
  const initialize = vi.spyOn(FileSessionStore.prototype, 'initialize').mockResolvedValue();
  const rebuild = vi
    .spyOn(FileSessionStore.prototype, 'rebuildIndex')
    .mockResolvedValue({ checkedAt: history.checkedAt, rebuilt: 2, skipped: 0, issues: [] });
  await showDiagnostics(client, undefined, { rebuildIndex: true });
  expect(initialize).toHaveBeenCalledWith({ recover: false });
  expect(rebuild).toHaveBeenCalledOnce();
  expect(owner.release).toHaveBeenCalledOnce();
});

it('экспорт автоматически проверяет историю и не копирует локальные пути', async () => {
  const directory = await temporary();
  const path = join(directory, 'report.json');
  const request = vi.fn(async (method: string) =>
    method === 'diagnostics.verifyHistory'
      ? history
      : {
          version: '0.3.0',
          buildId: null,
          protocolVersion: 1,
          storageVersion: 1,
          state: '/PRIVATE/state',
        },
  );
  const client = context(directory, request);
  await showDiagnostics(client, undefined, { export: path });
  expect(request).toHaveBeenCalledWith('diagnostics.verifyHistory', {});
  const content = await readFile(path, 'utf8');
  expect(content).not.toContain('PRIVATE');
  expect(JSON.parse(content).history).toEqual(history);
});

it('повреждение истории устанавливает код неуспеха даже при доступном сервисе', async () => {
  const client = context(
    await temporary(),
    vi.fn().mockResolvedValue({
      ...history,
      healthy: false,
      readOnly: true,
      issues: [{ code: 'JOURNAL_TORN_TAIL', kind: 'run', record: 3 }],
    }),
  );
  await showDiagnostics(client, undefined, { verifyHistory: true });
  expect(process.exitCode).toBe(1);
});
