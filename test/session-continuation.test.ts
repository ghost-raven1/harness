import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, output, ScriptedProvider } from './helpers.js';

describe('Продолжение беседы из нескольких окон', () => {
  it('отклоняет ответ на устаревший ход, но повтор принятого запроса возвращает прежнюю задачу', async () => {
    const provider = new ScriptedProvider((_, index) => output('Вопрос ' + index));
    const app = await harness(provider);
    const first = await app.runtime.start({
      message: 'Первый вопрос',
      workspace: app.workspace,
      requestKey: 'first',
    });
    await app.runtime.wait(first.runId);
    const input = {
      message: 'Ответ из второго окна',
      workspace: app.workspace,
      sessionId: first.sessionId,
      expectedParentRunId: first.runId,
      requestKey: 'next',
    };
    const next = await app.runtime.start(input);
    await app.runtime.wait(next.runId);
    const before = provider.requests.length;
    await expect(
      app.runtime.start({ ...input, message: 'Устаревший ответ', requestKey: 'stale' }),
    ).rejects.toThrow('Беседа изменилась');
    expect(provider.requests).toHaveLength(before);
    expect(await app.runtime.start(input)).toEqual(next);
    expect(app.sessions.get(next.runId).parentRunId).toBe(first.runId);
  });

  it('атомарная запись не принимает снимок истории, устаревший после чтения фабрикой', async () => {
    const app = await harness(new ScriptedProvider(() => output('Ответ')));
    const first = await app.runtime.start({
      message: 'Начало',
      workspace: app.workspace,
      requestKey: 'root',
    });
    await app.runtime.wait(first.runId);
    const second = await app.runtime.start({
      message: 'Продолжение',
      workspace: app.workspace,
      sessionId: first.sessionId,
      expectedParentRunId: first.runId,
      requestKey: 'second',
    });
    await app.runtime.wait(second.runId);
    const stale = {
      ...app.sessions.get(second.runId),
      id: randomUUID(),
      requestKey: 'stale-store',
      requestHash: 'different',
      parentRunId: first.runId,
    };
    await expect(app.sessions.create(stale)).rejects.toThrow('Беседа изменилась');
    expect(app.sessions.list()).toHaveLength(2);
  });

  it('не принимает parent без session', async () => {
    const app = await harness(new ScriptedProvider(() => output('Ответ')));
    await expect(
      app.runtime.start({
        message: 'x',
        workspace: app.workspace,
        expectedParentRunId: randomUUID(),
        requestKey: 'invalid-parent',
      }),
    ).rejects.toThrow('Parent run requires a session');
  });
  it('не запускает модель для сообщения из пробелов', async () => {
    const provider = new ScriptedProvider(() => output('Не должен вызываться'));
    const app = await harness(provider);
    await expect(
      app.runtime.start({ message: ' \n\t ', workspace: app.workspace, requestKey: 'empty' }),
    ).rejects.toThrow('Опишите задачу');
    expect(provider.requests).toHaveLength(0);
    expect(app.sessions.list()).toHaveLength(0);
  });
});
