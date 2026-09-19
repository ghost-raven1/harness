import { expect, it, vi } from 'vitest';
import { ProviderError } from '../src/providers/errors.js';
import { eventually, harness, output, ScriptedProvider } from './helpers.js';

/** Останавливает тест на нужной границе операции без привязки к скорости диска. */
function gate(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(['cancel', 'close'] as const)(
  'продолжение одновременно с %s не оживляет остановленную задачу',
  async (action) => {
    const provider = new ScriptedProvider((_, index) => {
      if (index === 0)
        throw new ProviderError('Временное ограничение провайдера', false, false, {
          kind: 'rate_limit',
        });
      return output('Ответ после отмены');
    });
    const app = await harness(provider);
    const { runId } = await app.runtime.start({
      message: 'Проверь отмену продолжения',
      workspace: app.workspace,
      requestKey: 'concurrent-resume-cancel',
    });
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).status).toBe('paused');

    await Promise.all([
      app.runtime.resume(runId),
      action === 'cancel' ? app.runtime.cancel(runId) : app.runtime.close(),
    ]);
    await app.runtime.wait(runId);

    const stopped = app.sessions.get(runId);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.result).toBeUndefined();
    expect(stopped.agents[stopped.rootAgentId]!.status).toBe('cancelled');
    expect(app.runtime.busy()).toBe(false);
    const events = await app.sessions.history(runId, 0);
    const cancelledAt = events.findIndex((event) => event.type === 'run.cancelled');
    expect(cancelledAt).toBeGreaterThan(-1);
    expect(events.slice(cancelledAt + 1).map((event) => event.type)).not.toContain('run.completed');
  },
);

it.each(['cancel', 'close'] as const)(
  '%s дожидается регистрации запуска, видимого в журнале во время создания',
  async (action) => {
    const app = await harness(new ScriptedProvider(() => output('Ответ после отмены')));
    const create = app.sessions.create.bind(app.sessions);
    let runId: string | undefined;
    const saved = gate();
    const release = gate();
    vi.spyOn(app.sessions, 'create').mockImplementation(async (run) => {
      const created = await create(run);
      runId = created.id;
      saved.resolve();
      // Второе окно уже видит запись, но команда запуска ещё не получила подтверждение диска.
      await release.promise;
      return created;
    });
    const starting = app.runtime.start({
      message: 'Проверь остановку во время создания',
      workspace: app.workspace,
      requestKey: 'creating-' + action,
    });
    await saved.promise;
    const stopping = action === 'cancel' ? app.runtime.cancel(runId!) : app.runtime.close();
    release.resolve();
    await Promise.all([starting, stopping]);
    await app.runtime.wait(runId!);

    expect(app.sessions.get(runId!).status).toBe('cancelled');
    expect(app.sessions.get(runId!).result).toBeUndefined();
    expect(app.runtime.busy()).toBe(false);
  },
);

it('отмена перед продолжением сохраняется, а отклонённое продолжение не блокирует новые задачи', async () => {
  const provider = new ScriptedProvider((_, index) => {
    if (index === 0)
      throw new ProviderError('Временное ограничение провайдера', false, false, {
        kind: 'rate_limit',
      });
    return output('Отдельная задача');
  });
  const app = await harness(provider);
  const { runId } = await app.runtime.start({
    message: 'Пауза',
    workspace: app.workspace,
    requestKey: 'cancel-before-resume',
  });
  await app.runtime.wait(runId);
  const results = await Promise.allSettled([app.runtime.cancel(runId), app.runtime.resume(runId)]);
  expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(app.sessions.get(runId).status).toBe('cancelled');
  expect(provider.requests).toHaveLength(1);
  const next = await app.runtime.start({
    message: 'Новая задача после отклонения команды',
    workspace: app.workspace,
    requestKey: 'after-rejected-resume',
  });
  await app.runtime.wait(next.runId);
  expect(app.sessions.get(next.runId).result).toBe('Отдельная задача');
});

it('ожидание остановки модели не задерживает запуск и отмену другой задачи', async () => {
  const release = gate();
  const stopping = gate();
  const provider = new ScriptedProvider(async (request) => {
    if (request.messages.some((item) => item.content === 'Долгая остановка')) {
      await new Promise<void>((resolve) =>
        request.signal!.addEventListener('abort', () => resolve(), { once: true }),
      );
      stopping.resolve();
      await release.promise;
      throw new Error('Модель остановлена');
    }
    return output('Независимая задача выполнена');
  });
  const app = await harness(provider);
  const first = await app.runtime.start({
    message: 'Долгая остановка',
    workspace: app.workspace,
    requestKey: 'slow-stop',
  });
  await eventually(() => provider.requests.length === 1);
  let cancelled = false;
  const cancellation = app.runtime.cancel(first.runId).then(() => {
    cancelled = true;
  });
  await stopping.promise;
  const next = app.runtime.start({
    message: 'Независимая задача',
    workspace: app.workspace,
    requestKey: 'during-stop',
  });
  try {
    await eventually(() => provider.requests.length === 2);
    const { runId } = await next;
    await app.runtime.wait(runId);
    await app.runtime.cancel(runId);
    expect(app.sessions.get(runId).result).toBe('Независимая задача выполнена');
    expect(cancelled).toBe(false);
    expect(app.runtime.busy()).toBe(true);
  } finally {
    release.resolve();
    await Promise.all([next, cancellation]);
  }
  expect(app.sessions.get(first.runId).status).toBe('cancelled');
  expect(app.runtime.busy()).toBe(false);
});
