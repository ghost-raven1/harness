import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { call, eventually, harness, output, ScriptedProvider } from './helpers.js';

it('следующий вопрос сохраняет успешный результат записи из отменённого пакета', async () => {
  let reading = false;
  const provider = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [
          call('written', 'fs.write', { path: 'ready.txt', content: 'Запись сохранена' }),
          call('waiting', 'test.wait', {}),
        ])
      : output('История прочитана'),
  );
  const app = await harness(provider);
  app.registry.register({
    definition: {
      name: 'test.wait',
      effect: 'read',
      description: 'Ожидание отмены',
      schema: { type: 'object' },
    },
    async execute(_, context) {
      reading = true;
      await new Promise<void>((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('CANCELLED')), {
          once: true,
        });
      });
      return null;
    },
  });
  const first = await app.runtime.start({
    message: 'Запиши и проверь',
    workspace: app.workspace,
    requestKey: 'first',
  });
  await eventually(() => reading);
  await app.runtime.cancel(first.runId);
  const prior = app.sessions.get(first.runId);
  const invocation = prior.invocations[prior.rootAgentId + ':written']!;
  expect(invocation.status).toBe('succeeded');
  expect(prior.agents[prior.rootAgentId]!.pending).toHaveLength(2);
  const next = await app.runtime.start({
    message: 'Что успело сохраниться?',
    workspace: app.workspace,
    sessionId: first.sessionId,
    requestKey: 'next',
  });
  await app.runtime.wait(next.runId);
  expect(
    provider.requests[1]!.messages.find((message) => message.toolCallId === 'written')?.content,
  ).toBe(invocation.result);
  expect(
    provider.requests[1]!.messages.filter((message) => message.toolCallId === 'written'),
  ).toHaveLength(1);
  expect(await readFile(join(app.workspace, 'ready.txt'), 'utf8')).toBe('Запись сохранена');
});
