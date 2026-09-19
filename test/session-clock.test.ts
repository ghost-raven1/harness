import { expect, it, vi } from 'vitest';
import { harness, output, ScriptedProvider } from './helpers.js';

it.each([false, true])(
  'продолжает последний этап после перевода часов назад (привязка к ответу: %s)',
  async (expectedParent) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
      const provider = new ScriptedProvider((_, index) => output('Ответ ' + (index + 1)));
      const app = await harness(provider);
      const first = await app.runtime.start({
        message: 'Первый вопрос',
        workspace: app.workspace,
        requestKey: 'first',
      });
      await app.runtime.wait(first.runId);
      vi.setSystemTime(new Date('2026-09-14T11:00:00Z'));
      const second = await app.runtime.start({
        message: 'Второй вопрос',
        workspace: app.workspace,
        requestKey: 'second',
        sessionId: first.sessionId,
      });
      await app.runtime.wait(second.runId);
      expect(
        app.sessions.get(second.runId).createdAt < app.sessions.get(first.runId).createdAt,
      ).toBe(true);
      await app.sessions.initialize();
      const third = await app.runtime.start({
        message: 'Третий вопрос',
        workspace: app.workspace,
        requestKey: 'third',
        sessionId: first.sessionId,
        ...(expectedParent ? { expectedParentRunId: second.runId } : {}),
      });
      await app.runtime.wait(third.runId);
      expect(app.sessions.get(third.runId).parentRunId).toBe(second.runId);
      expect(provider.requests.at(-1)!.messages).toContainEqual({
        role: 'assistant',
        content: 'Ответ 2',
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it('скрытый промежуточный этап сохраняет связь с последним ответом при сбое часов', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const provider = new ScriptedProvider((_, index) => output('Ответ ' + (index + 1)));
    const app = await harness(provider);
    let sessionId: string | undefined;
    const ids: string[] = [];
    for (const [index, hour] of [12, 13, 11].entries()) {
      vi.setSystemTime(new Date(`2026-09-14T${hour}:00:00Z`));
      const next = await app.runtime.start({
        message: 'Вопрос ' + index,
        workspace: app.workspace,
        requestKey: 'step-' + index,
        sessionId,
      });
      await app.runtime.wait(next.runId);
      sessionId = next.sessionId;
      ids.push(next.runId);
    }
    await app.sessions.delete(ids[1]!);
    await app.sessions.initialize();
    const next = await app.runtime.start({
      message: 'Продолжи после скрытия',
      workspace: app.workspace,
      requestKey: 'after-hidden',
      sessionId,
      expectedParentRunId: ids[2]!,
    });
    await app.runtime.wait(next.runId);
    expect(app.sessions.get(next.runId).parentRunId).toBe(ids[2]);
    expect(provider.requests.at(-1)!.messages).toContainEqual({
      role: 'assistant',
      content: 'Ответ 2',
    });
    expect(provider.requests.at(-1)!.messages).toContainEqual({
      role: 'assistant',
      content: 'Ответ 3',
    });
  } finally {
    vi.useRealTimers();
  }
});
