import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';
import { newAgent } from '../src/agents/service.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

it.each([false, true])(
  'продолжение после ручной проверки сохраняет порядок tool-обмена и поздний факт скрытого этапа: %s',
  async (hidden) => {
    let writes = 0;
    const provider = new ScriptedProvider((_, index) =>
      index === 0
        ? output('', [call('interrupted-write', 'fixture.write', {})])
        : output('Продолжено с проверенным результатом'),
    );
    const app = await harness(provider);
    app.registry.register({
      definition: {
        name: 'fixture.write',
        description: 'Проверочная запись',
        schema: { type: 'object', additionalProperties: false },
        effect: 'write',
      },
      async execute() {
        writes++;
        throw new ToolOutcomeUnknownError('Проверочный разрыв после начала записи');
      },
    });
    const previous = await app.runtime.start({
      message: 'Исходная задача',
      workspace: app.workspace,
      requestKey: 'original',
    });
    await app.runtime.wait(previous.runId);
    expect(app.sessions.get(previous.runId).status).toBe('paused');
    await app.runtime.cancel(previous.runId);
    const interrupted = app.sessions.get(previous.runId);
    const prior = interrupted.agents[interrupted.rootAgentId]!;
    const invocation = Object.values(interrupted.invocations)[0]!;
    expect(invocation.status).toBe('unknown');
    expect(prior.messages.at(-1)?.toolCalls?.[0]?.id).toBe('interrupted-write');
    expect(prior.pending?.[0]?.id).toBe('interrupted-write');

    if (hidden) {
      // Имитирует сохранённое старой версией продолжение, созданное до проверки исходного этапа.
      const legacy = newAgent('coordinator', 'Вопрос в более позднем этапе');
      legacy.messages = [
        ...prior.messages,
        { role: 'tool', toolCallId: 'interrupted-write', content: 'Исход ещё не проверен' },
        ...legacy.messages,
        { role: 'assistant', content: 'Ответ позднего этапа' },
      ];
      legacy.status = 'completed';
      await app.sessions.create({
        ...interrupted,
        id: randomUUID(),
        requestKey: 'legacy',
        requestHash: 'legacy',
        rootAgentId: legacy.id,
        agents: { [legacy.id]: legacy },
        invocations: {},
        status: 'completed',
        createdAt: new Date(Date.now() + 1000).toISOString(),
      });
      await app.sessions.delete(previous.runId);
    }

    await app.runtime.resolveInvocation(
      previous.runId,
      invocation.id,
      'Подтверждено вручную: файл содержит 42 строки',
      true,
    );
    expect(app.sessions.get(previous.runId).agents[interrupted.rootAgentId]!.messages).toEqual(
      prior.messages,
    );
    const next = await app.runtime.start({
      message: 'Продолжи исходную задачу',
      workspace: app.workspace,
      sessionId: previous.sessionId,
      requestKey: 'continue-after-check',
    });
    await app.runtime.wait(next.runId);
    const messages = provider.requests.at(-1)!.messages;
    const callIndex = messages.findIndex((message) =>
      message.toolCalls?.some((item) => item.id === 'interrupted-write'),
    );
    expect(messages[callIndex + 1]).toMatchObject({
      role: 'tool',
      toolCallId: 'interrupted-write',
    });
    if (!hidden)
      expect(messages[callIndex + 1]!.content).toBe(
        'Подтверждено вручную: файл содержит 42 строки',
      );
    const factIndex = messages.findIndex(
      (message) =>
        message.role === 'user' &&
        message.content.includes('Подтверждено вручную: файл содержит 42 строки'),
    );
    expect(factIndex).toBeGreaterThan(callIndex + 1);
    expect(messages[factIndex]!.content).toContain(previous.runId);
    expect(messages.slice(factIndex + 1)).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'Продолжи исходную задачу' }),
    );
    if (hidden)
      expect(messages).toContainEqual(expect.objectContaining({ content: 'Ответ позднего этапа' }));
    expect(app.sessions.get(next.runId).status).toBe('completed');
    expect(writes).toBe(1);
    expect(app.sessions.get(next.runId).invocations).toEqual({});
  },
);
