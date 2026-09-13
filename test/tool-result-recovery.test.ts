import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { call, harness, output, ScriptedProvider } from './helpers.js';

it.each(['serialization', 'artifact', 'journal'] as const)(
  'не повторяет выполненную запись после ошибки сохранения результата: %s',
  async (failure) => {
    const provider = new ScriptedProvider((_, index) =>
      index === 0 ? output('', [call('effect', 'test.write', {})]) : output('Проверено'),
    );
    const app = await harness(provider, (config) => {
      config.tools.resultBytes = 256;
    });
    const target = join(app.workspace, 'effects.txt');
    app.registry.register({
      definition: {
        name: 'test.write',
        effect: 'write',
        description: 'Запись с контролируемым сбоем результата',
        schema: { type: 'object' },
      },
      async execute() {
        await appendFile(target, 'одна запись\n');
        if (failure === 'serialization') return { value: 1n };
        return { content: failure === 'artifact' ? 'x'.repeat(1000) : 'готово' };
      },
    });
    if (failure === 'artifact')
      vi.spyOn(app.sessions, 'artifact').mockRejectedValueOnce(new Error('ENOSPC'));
    if (failure === 'journal') {
      const mutate = app.sessions.mutate.bind(app.sessions);
      vi.spyOn(app.sessions, 'mutate').mockImplementation((runId, type, payload, update) => {
        if (type === 'tool.succeeded') return Promise.reject(new Error('EIO'));
        return mutate(runId, type, payload, update);
      });
    }
    const { runId } = await app.runtime.start({
      message: 'Одна запись',
      workspace: app.workspace,
      requestKey: 'result-' + failure,
    });
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.status).toBe('paused');
    expect(Object.values(run.invocations)[0]?.status).toBe('unknown');
    expect(provider.requests).toHaveLength(1);
    await expect(app.runtime.resume(runId)).rejects.toThrow('unknown');
    const invocationId = Object.keys(run.invocations)[0]!;
    await app.runtime.resolveInvocation(runId, invocationId, 'Файл проверен: запись есть', true);
    await app.runtime.resume(runId);
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).status).toBe('completed');
    expect(await readFile(target, 'utf8')).toBe('одна запись\n');
  },
);

it('не понижает подтверждённую журналом запись при поздней ошибке снимка', async () => {
  const app = await harness(
    new ScriptedProvider((_, index) =>
      index === 0
        ? output('', [call('write', 'fs.write', { path: 'ready.txt', content: 'готово' })])
        : output('Готово'),
    ),
  );
  const mutate = app.sessions.mutate.bind(app.sessions);
  vi.spyOn(app.sessions, 'mutate').mockImplementation(async (runId, type, payload, update) => {
    const state = await mutate(runId, type, payload, update);
    if (type === 'tool.succeeded') throw new Error('Снимок недоступен после записи журнала');
    return state;
  });
  const { runId } = await app.runtime.start({
    message: 'Запиши файл',
    workspace: app.workspace,
    requestKey: 'committed-result',
  });
  await app.runtime.wait(runId);
  const run = app.sessions.get(runId);
  expect(run.status).toBe('completed');
  expect(Object.values(run.invocations).map((invocation) => invocation.status)).toEqual([
    'succeeded',
  ]);
  expect(await readFile(join(app.workspace, 'ready.txt'), 'utf8')).toBe('готово');
});

it('ошибка упаковки чтения возвращается модели без ручной проверки побочного эффекта', async () => {
  const provider = new ScriptedProvider((request, index) => {
    if (index === 0) return output('', [call('read', 'test.read', {})]);
    expect(request.messages.find((item) => item.role === 'tool')?.content).toContain('error');
    return output('Чтение не удалось');
  });
  const app = await harness(provider);
  app.registry.register({
    definition: {
      name: 'test.read',
      effect: 'read',
      description: 'Чтение с некорректным результатом',
      schema: { type: 'object' },
    },
    async execute() {
      return 1n;
    },
  });
  const { runId } = await app.runtime.start({
    message: 'Прочитай',
    workspace: app.workspace,
    requestKey: 'read-result-error',
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('completed');
  expect(Object.values(app.sessions.get(runId).invocations)[0]?.status).toBe('error');
});
