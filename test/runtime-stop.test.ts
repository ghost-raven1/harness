import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { eventually, harness, output, ScriptedProvider } from './helpers.js';

it('повторная отмена и закрытие ждут фактической остановки уже отменённого запроса', async () => {
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopping = false;
  const provider = new ScriptedProvider(async (request) => {
    await new Promise<void>((resolve) =>
      request.signal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    stopping = true;
    await cleanup;
    throw new Error('Запрос остановлен после завершения очистки');
  });
  const app = await harness(provider);
  const { runId } = await app.runtime.start({
    message: 'Останови запрос',
    workspace: app.workspace,
    requestKey: 'cancel-drain',
  });
  await eventually(() => provider.requests.length === 1);
  const first = app.runtime.cancel(runId);
  await eventually(() => stopping && app.sessions.get(runId).status === 'cancelled');
  let cancelled = false;
  let closed = false;
  const second = app.runtime.cancel(runId).then(() => {
    cancelled = true;
  });
  const closing = app.runtime.close().then(() => {
    closed = true;
  });
  try {
    await setImmediate();
    expect(cancelled).toBe(false);
    expect(closed).toBe(false);
    expect(app.runtime.busy()).toBe(true);
  } finally {
    finish();
    await Promise.all([first, second, closing]);
  }
  expect(app.runtime.busy()).toBe(false);
  expect(app.sessions.get(runId).status).toBe('cancelled');
  expect(
    app.sessions.history(runId, 0).filter((event) => event.type === 'run.cancelled'),
  ).toHaveLength(1);
});

it.each(['completed', 'failed'] as const)(
  'закрытие ждёт завершающую запись задачи %s и сохраняет её исход',
  async (status) => {
    const provider = new ScriptedProvider(() => {
      if (status === 'failed') throw new Error('Проверочная ошибка модели');
      return output('Сохранённый ответ');
    });
    const app = await harness(provider);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    app.runtime.onTerminal(async (runId) => {
      entered = true;
      await gate;
      await app.sessions.mutate(runId, 'test.terminal_saved', {}, () => undefined);
    });
    const { runId } = await app.runtime.start({
      message: 'Заверши задачу',
      workspace: app.workspace,
      requestKey: 'terminal-' + status,
    });
    await eventually(() => entered);
    expect(app.sessions.get(runId).status).toBe(status);
    let closed = false;
    const closing = app.runtime.close().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      expect(closed).toBe(false);
      expect(app.runtime.busy()).toBe(true);
    } finally {
      release();
      await closing;
      await app.runtime.wait(runId);
    }
    expect(app.runtime.busy()).toBe(false);
    expect(app.sessions.get(runId).status).toBe(status);
    expect(app.sessions.history(runId, 0).at(-1)!.type).toBe('test.terminal_saved');
  },
);
