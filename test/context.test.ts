import { it, expect } from 'vitest';
import { harness, ScriptedProvider, output, call } from './helpers.js';

it('compaction сохраняет пары вызов–результат, ограничения, задачу и замороженную версию', async () => {
  const provider = new ScriptedProvider(() => output('Готово'));
  const app = await harness(provider);
  const { runId } = await app.runtime.start({
    message: 'Исходная задача',
    workspace: app.workspace,
    requestKey: 'compact',
  });
  await app.runtime.wait(runId);
  await app.sessions.mutate(runId, 'test.history', {}, (run) => {
    const agent = run.agents[run.rootAgentId]!;
    agent.messages = [
      { role: 'user', content: 'Исходная задача' },
      { role: 'assistant', content: '', toolCalls: [call('old', 'fs.read', { path: 'a' })] },
      { role: 'tool', toolCallId: 'old', content: 'старые данные '.repeat(2000) },
      { role: 'assistant', content: '', toolCalls: [call('keep', 'fs.read', { path: 'b' })] },
      { role: 'tool', toolCallId: 'keep', content: 'Свежая проверка' },
    ];
  });
  const before = app.sessions.get(runId),
    agent = before.agents[before.rootAgentId]!;
  expect(app.context.needsCompaction(before, agent, [])).toBe(true);
  const compactor = new ScriptedProvider(() => output('Проверен файл a; остаётся решение по b.'));
  const compacted = await app.context.compact(
    before,
    agent,
    compactor,
    new AbortController().signal,
  );
  expect(compacted.messages).toHaveLength(2);
  expect(compacted.messages[0]?.toolCalls?.[0]?.id).toBe(compacted.messages[1]?.toolCallId);
  agent.messages = compacted.messages;
  agent.summary = compacted.summary;
  const messages = app.context.build(before, agent, []);
  expect(messages[0]!.content).toContain('Запреты обязательны');
  expect(messages.at(-1)!.content).toContain('Исходная задача');
  expect(before.learningVersion).toBe('baseline');
  expect(before.config).toEqual(app.snapshot);
  app.context.assertFits(before, agent, []);
});
it('слишком большой обязательный контекст останавливается с диагностикой', async () => {
  const app = await harness(new ScriptedProvider(() => output('unused')), (config) => {
    config.basePrompt = 'Ограничения '.repeat(20000);
  });
  const { runId } = await app.runtime.start({
    message: 'x',
    workspace: app.workspace,
    requestKey: 'overflow',
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('failed');
  expect(app.sessions.get(runId).error).toMatch(/CONTEXT_LIMIT/);
});
