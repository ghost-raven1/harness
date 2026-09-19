import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newAgent } from '../src/agents/service.js';
import { appendJournal } from '../src/sessions/journal.js';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';
import { ProviderError } from '../src/providers/errors.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

/** Загружает старую беседу с непроверенной записью и более поздним этапом на паузе. */
async function legacySession(hidden: boolean, pauseAgain = false) {
  let writes = 0;
  const provider = new ScriptedProvider((_, index) => {
    if (pauseAgain && index === 1)
      throw new ProviderError('Временный лимит', false, false, { kind: 'rate_limit' });
    return index === 0
      ? output('', [call('write', 'fixture.write', {})])
      : output('Завершено после проверки');
  });
  const app = await harness(provider);
  const path = join(app.workspace, 'result.txt');
  app.registry.register({
    definition: {
      name: 'fixture.write',
      description: 'Проверочная запись',
      effect: 'write',
      schema: { type: 'object' },
    },
    async execute() {
      writes++;
      await writeFile(path, '42 строки');
      throw new ToolOutcomeUnknownError('Сбой после записи');
    },
  });
  const first = await app.runtime.start({
    message: 'Запиши файл',
    workspace: app.workspace,
    requestKey: 'first',
  });
  await app.runtime.wait(first.runId);
  await app.runtime.cancel(first.runId);
  if (hidden) await app.sessions.delete(first.runId);
  const prior = app.sessions.get(first.runId);
  const agent = newAgent('coordinator', 'Продолжи проверку');
  const read = call('read', 'fs.read', { path: 'result.txt' });
  agent.messages = [
    ...prior.agents[prior.rootAgentId]!.messages,
    { role: 'tool', toolCallId: 'write', content: 'Результат ещё не проверен' },
    ...agent.messages,
    { role: 'assistant', content: '', toolCalls: [read] },
  ];
  agent.pending = [read];
  const run = {
    ...prior,
    id: randomUUID(),
    parentRunId: prior.id,
    requestKey: 'legacy',
    requestHash: 'legacy',
    deletedAt: undefined,
    rootAgentId: agent.id,
    agents: { [agent.id]: agent },
    invocations: {},
    status: 'paused' as const,
    createdAt: new Date().toISOString(),
  };
  await appendJournal(join(app.sessions.directory, 'runs', run.id + '.jsonl'), {
    seq: 1,
    at: run.createdAt,
    type: 'run.created',
    payload: {},
    state: run,
  });
  await app.sessions.initialize();
  return {
    ...app,
    first,
    run,
    provider,
    path,
    writes: () => writes,
    invocationId: Object.keys(prior.invocations)[0]!,
  };
}

it.each([false, true])(
  'resume проверяет неизвестные операции прежних этапов (скрыт: %s)',
  async (hidden) => {
    const app = await legacySession(hidden);
    try {
      await expect(app.runtime.resume(app.run.id)).rejects.toThrow(/неизвестн/);
      expect(app.sessions.get(app.run.id).status).toBe('paused');
      expect(app.provider.requests).toHaveLength(1);
      expect(app.sessions.get(app.run.id).invocations).toEqual({});
    } finally {
      await app.runtime.wait(app.run.id);
    }
  },
);

it('поздняя проверка переживает повторную паузу и перезапуск без дублирования', async () => {
  const app = await legacySession(true, true);
  const fact = 'Проверено вручную: запись выполнена один раз';
  await app.runtime.resolveInvocation(app.first.runId, app.invocationId, fact, true);
  await app.runtime.resume(app.run.id);
  await app.runtime.wait(app.run.id);
  const paused = app.sessions.get(app.run.id);
  expect(paused.status).toBe('paused');
  const summary = paused.agents[paused.rootAgentId]!.summary;
  expect(summary).toContain(fact);
  await app.sessions.initialize();
  await app.runtime.resume(app.run.id);
  await app.runtime.wait(app.run.id);
  const completed = app.sessions.get(app.run.id);
  expect(completed.status).toBe('completed');
  expect(completed.agents[completed.rootAgentId]!.summary).toBe(summary);
  expect(
    app.provider.requests.at(-1)!.messages.filter((message) => message.content.includes(fact)),
  ).toHaveLength(1);
  expect(
    (await app.sessions.history(app.run.id, 0)).filter((event) => event.type === 'tool.started'),
  ).toHaveLength(1);
  expect(app.writes()).toBe(1);
});

it.each([false, true])(
  'resume получает позднюю ручную проверку, сохраняя обмены инструментов (скрыт: %s)',
  async (hidden) => {
    const app = await legacySession(hidden);
    await app.runtime.resolveInvocation(
      app.first.runId,
      app.invocationId,
      'Проверено человеком: файл содержит 42 строки',
      true,
    );
    const before = app.sessions.get(app.run.id);
    await app.runtime.resume(app.run.id);
    await app.runtime.wait(app.run.id);
    const request = app.provider.requests.at(-1)!;
    expect(
      request.messages.some((message) =>
        message.content.includes('Проверено человеком: файл содержит 42 строки'),
      ),
    ).toBe(true);
    const readIndex = request.messages.findIndex((message) =>
      message.toolCalls?.some((call) => call.id === 'read'),
    );
    expect(request.messages[readIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'read' });
    const after = app.sessions.get(app.run.id);
    expect(after.status).toBe('completed');
    expect(after.config).toEqual(before.config);
    expect(after.learningVersion).toBe(before.learningVersion);
    expect(app.writes()).toBe(1);
    expect(await readFile(app.path, 'utf8')).toBe('42 строки');
  },
);
