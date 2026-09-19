import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { rpc, serve, socketPath } from '../src/interfaces/ipc.js';
import { readAccessToken } from '../src/interfaces/local-channel.js';
import { cleanup, configDirectory, eventually, temporary } from './helpers.js';
import { modelServer } from './process-fixture.js';

it('локальный сервис сохраняет отмену при двух командах после HTTP 429', async () => {
  const root = await temporary();
  const directory = join(root, 'state');
  let requests = 0;
  const api = await modelServer(() =>
    ++requests === 1 ? { status: 429 } : { text: 'Этот ответ не должен оживить задачу' },
  );
  const service = await serve(await configDirectory(root, api.baseUrl), directory);
  cleanup(() => service.close());
  const { runId } = await rpc<{ runId: string }>(directory, 'runtime.run', {
    message: 'Проверь продолжение после ограничения провайдера',
    workspace: join(root, 'workspace'),
    requestKey: 'ipc-resume-cancel',
  });
  await service.app.runtime.wait(runId);
  expect(service.app.sessions.get(runId).status).toBe('paused');

  const token = await readAccessToken(directory);
  const socket = createConnection(socketPath(directory));
  socket.setEncoding('utf8');
  let buffer = '';
  const replies: Array<{ id: string; error?: unknown }> = [];
  socket.on('data', (data) => {
    buffer += data;
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  try {
    await once(socket, 'connect');
    // Один пакет задаёт порядок поступления, но сервис обрабатывает команды независимо.
    socket.write(
      ['resume', 'cancel']
        .map((action) =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: action,
            method: 'runtime.' + action,
            params: { runId },
            token,
          }),
        )
        .join('\n') + '\n',
    );
    await eventually(() => replies.length === 2, 15000);
  } finally {
    socket.destroy();
  }
  expect(replies.map((reply) => reply.id).sort()).toEqual(['cancel', 'resume']);
  expect(replies.every((reply) => !reply.error)).toBe(true);
  await service.app.runtime.wait(runId);
  expect(await rpc(directory, 'runtime.status', { runId })).toMatchObject({
    status: 'cancelled',
  });
  expect(service.app.runtime.busy()).toBe(false);
  expect(service.app.sessions.get(runId).result).toBeUndefined();
}, 40000);
