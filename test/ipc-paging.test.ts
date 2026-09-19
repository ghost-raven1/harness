import { it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { commandClient, serve, rpc, rpcRaw, socketPath } from '../src/interfaces/ipc.js';
import { createAccessToken } from '../src/interfaces/local-channel.js';
import { createMcpServer } from '../src/interfaces/mcp-server.js';
import { RESULT_PAGE_BYTES, textPage } from '../src/interfaces/result-pages.js';
import { completeResult } from '../src/interfaces/result-client.js';
import { saveAnswer } from '../src/interfaces/guided/answer-export.js';
import type { StatusView, RunSummary } from '../src/interfaces/types.js';
import { temporary, configDirectory, cleanup } from './helpers.js';
import { modelServer } from './process-fixture.js';

it('ошибки сериализации и размера отклоняются до открытия сокета, следующий запрос работает', async () => {
  const directory = await temporary();
  await createAccessToken(directory);
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.once('data', (data) => {
      const request = JSON.parse(String(data));
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'ok' }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath(directory), resolve));
  cleanup(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const params of [{ value: 1n }, cycle])
    await expect(rpcRaw(directory, 'system.info', params)).rejects.toThrow('формате JSON');
  await expect(rpcRaw(directory, 'system.info', { text: '\0'.repeat(210000) })).rejects.toThrow(
    'Запрос слишком большой',
  );
  expect(connections).toBe(0);
  expect(await rpcRaw(directory, 'system.info')).toBe('ok');
  expect(connections).toBe(1);
});

it('страницы учитывают JSON-escape и Unicode, соединение частей не теряет символы', () => {
  const original = '🙂頭ё\n"\\é'.repeat(31);
  let cursor = 0,
    result = '';
  do {
    const part = textPage(original, cursor, 31);
    expect(Buffer.byteLength(JSON.stringify(part.text))).toBeLessThanOrEqual(31);
    expect(part.nextCursor).toBeGreaterThan(cursor);
    expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    result += part.text;
    cursor = part.nextCursor;
  } while (cursor < original.length);
  expect(result).toBe(original);
  expect(() => textPage(original, 1)).toThrow('Unicode');
});

it('real IPC и MCP читают большой сохранённый ответ, экспорт сохраняет весь текст', async () => {
  const root = await temporary(),
    directory = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Обычный ответ' }));
  const service = await serve(await configDirectory(root, api.baseUrl), directory);
  cleanup(() => service.close());
  const { runId } = await rpc(directory, 'runtime.run', {
    workspace: join(root, 'workspace'),
    message: 'Исходная задача',
    requestKey: 'long-result',
  });
  await service.app.runtime.wait(runId);
  const ordinary = await rpc(directory, 'runtime.status', { runId });
  expect(ordinary.result).toBe('Обычный ответ');
  expect(ordinary.resultPage).toBeUndefined();
  const result = '🙂я\n"\\'.repeat(750000);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(8 * 1024 * 1024);
  await service.app.sessions.mutate(runId, 'test.result_saved', {}, (run) => {
    run.result = result;
  });
  const status = await rpc(directory, 'runtime.status', { runId });
  expect(status.resultTruncated).toBe(true);
  expect(status.resultLength).toBe(result.length);
  expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThan(8 * 1024 * 1024);
  expect((await rpc(directory, 'runtime.task', { runId })).resultPage).toEqual(status.resultPage);
  await expect(saveAnswer(status)).rejects.toThrow('ещё не дочитан');
  const full = await completeResult({ request: commandClient(() => directory) }, status);
  expect(full.result).toBe(result);
  const path = await saveAnswer(full);
  expect(await readFile(path, 'utf8')).toBe(result + '\n');
  expect(service.app.sessions.get(runId).result).toBe(result);

  const mcp = createMcpServer(directory);
  const client = new Client({ name: 'paging-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  cleanup(async () => {
    await client.close();
    await mcp.close();
  });
  expect((await client.listTools()).tools).toHaveLength(3);
  const next = await client.callTool({
    name: 'harness.status',
    arguments: { runId, resultCursor: status.resultPage!.nextCursor },
  });
  const page = (next.structuredContent as unknown as StatusView).resultPage!;
  expect(page.cursor).toBe(status.resultPage!.nextCursor);
  expect(page.text).toBe(result.slice(page.cursor, page.nextCursor));
  expect(Buffer.byteLength(JSON.stringify(page.text))).toBeLessThanOrEqual(RESULT_PAGE_BYTES);
  await expect(rpc(directory, 'runtime.result', { runId, cursor: 1 })).rejects.toThrow('Unicode');

  const override = vi.spyOn(service.app.diagnostics, 'status').mockReturnValue({
    enabled: false,
    file: 'x'.repeat(8 * 1024 * 1024),
    directory: '',
    maxBytes: 1,
    retainedFiles: 0,
  });
  try {
    await expect(rpc(directory, 'diagnostics.status')).rejects.toThrow('Ответ слишком большой');
  } finally {
    override.mockRestore();
  }
  expect(await rpc(directory, 'system.info')).toHaveProperty('version');
}, 60000);

it('список длинных задач помещается в IPC; страницы и поиск сохраняют полный состав', async () => {
  const root = await temporary(),
    directory = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Ответ' }));
  const service = await serve(await configDirectory(root, api.baseUrl), directory);
  cleanup(() => service.close());
  const { runId } = await rpc(directory, 'runtime.run', {
    workspace: join(root, 'workspace'),
    message: 'Начало',
    requestKey: 'list-source',
  });
  await service.app.runtime.wait(runId);
  const original = service.app.sessions.get(runId);
  const task = 'а'.repeat(99994) + 'КОНЕЦ!';
  for (let index = 0; index < 43; index++) {
    const run = structuredClone(original);
    run.id = randomUUID();
    run.sessionId = randomUUID();
    run.requestKey = 'list-' + index;
    run.agents[run.rootAgentId]!.task = task;
    await service.app.sessions.create(run);
  }
  const all = await rpc(directory, 'runtime.list');
  expect(all).toHaveLength(44);
  expect(Buffer.byteLength(JSON.stringify(all))).toBeLessThan(8 * 1024 * 1024);
  expect(all.filter((item) => item.taskTruncated)).toHaveLength(43);
  const parts: RunSummary[] = [];
  for (let offset = 0; offset < all.length; offset += 10)
    parts.push(...(await rpc(directory, 'runtime.list', { offset, limit: 10 })));
  expect(parts).toEqual(all);
  const fullTask = await rpc(directory, 'runtime.status', {
    runId: all.find((item) => item.taskTruncated)!.runId,
  });
  expect(fullTask.task).toBe(task);
  const history = await rpc(directory, 'runtime.history', {
    query: 'КОНЕЦ!',
    limit: 50,
  });
  expect(history.total).toBe(43);
  expect(history.items).toHaveLength(43);
}, 30000);
