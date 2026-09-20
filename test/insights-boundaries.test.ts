import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ActivityObserver } from '../src/insights/observer.js';
import { ActivityReader } from '../src/insights/reader.js';
import { InsightsService } from '../src/insights/service.js';
import { insightCommands } from '../src/insights/read-schema.js';
import { runInsightsSchema } from '../src/insights/schema.js';
import { RunObservations } from '../src/runtime/observations.js';
import { appendJournalBatch } from '../src/sessions/journal.js';
import { harness, output, ScriptedProvider, temporary } from './helpers.js';

/** Создаёт обычную завершённую задачу без включённого сбора метрик. */
async function completedRun() {
  const app = await harness(new ScriptedProvider(() => output('Готово')));
  const { runId } = await app.runtime.start({
    message: 'Проверка',
    workspace: app.workspace,
    requestKey: randomUUID(),
  });
  await app.runtime.wait(runId);
  return { app, run: app.sessions.get(runId) };
}

it('страница активности и сводка одинаково обозначают прерванную фазу после рестарта', async () => {
  const { app, run } = await completedRun();
  const directory = join(app.directory, 'measurements');
  const original = new InsightsService(directory, app.sessions);
  original.observer
    .scope({ runId: run.id, agentId: run.rootAgentId, role: 'coordinator', profile: run.profile })
    .begin('model.request');
  expect((await original.activity(run.id, 0, 100)).completeness).toBe('complete');
  await original.observer.close();
  const restarted = new InsightsService(directory, app.sessions);
  try {
    expect((await restarted.activity(run.id, 0, 100)).completeness).toBe('partial');
    const report = await restarted.report(run.id);
    expect(report.completeness).toBe('partial');
    expect(report.roles[0]?.interrupted).toBe(1);
    expect(report.roles[0]?.phases['model.request']).toBeUndefined();
  } finally {
    await restarted.observer.close();
  }
});

it('завершение освобождает участок; новый запуск и смена роли того же агента не склеиваются', async () => {
  const { app, run } = await completedRun();
  const reader = new ActivityReader(join(app.directory, 'measurements'));
  const observer = new ActivityObserver(reader);
  const release = vi.spyOn(observer, 'release');
  const lifecycle = new RunObservations(observer);
  lifecycle.start(run).end();
  await lifecycle.stop(run);
  expect(release).toHaveBeenCalledExactlyOnceWith(run.id);
  const scope = {
    runId: run.id,
    agentId: run.rootAgentId,
    role: 'coordinator',
    profile: run.profile,
  };
  observer.scope(scope).begin('agent').end();
  observer
    .scope({ ...scope, role: 'worker' })
    .begin('agent')
    .end();
  await observer.flush();
  const { data } = await reader.read(run.id);
  expect(data.roles.map((role) => role.role)).toEqual(['coordinator', 'coordinator', 'worker']);
  expect(new Set(data.roles.map((role) => role.episodeId)).size).toBe(3);
  expect(data.partial).toBe(false);
  await observer.close();
});

it('освобождение участка при паузе не мешает закрыть её после продолжения', async () => {
  const { app, run } = await completedRun();
  const reader = new ActivityReader(join(app.directory, 'measurements'));
  let ticks = 0;
  const observer = new ActivityObserver(reader, {
    clock: { monotonic: () => ticks, calendar: () => new Date().toISOString() },
  });
  const lifecycle = new RunObservations(observer);
  lifecycle.start(run).end();
  await lifecycle.stop({ ...run, status: 'paused' });
  ticks = 20;
  lifecycle.start(run).end();
  await lifecycle.stop(run);
  const { data } = await reader.read(run.id);
  expect(data.pauseMs).toBe(20);
  expect(data.open).toEqual([]);
  expect(data.partial).toBe(false);
  await observer.close();
});

it('пропуск всей второй задачи во время записи пачки сохраняет маркер отдельно', async () => {
  const directory = await temporary();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = new ActivityReader(directory);
  const observer = new ActivityObserver(reader, {
    maximumBytes: 900,
    append: async (...args) => {
      entered();
      await gate;
      return appendJournalBatch(...args);
    },
  });
  const runA = randomUUID(),
    runB = randomUUID();
  const scoped = (runId: string) =>
    observer.scope({
      runId,
      agentId: randomUUID(),
      role: 'coordinator',
      profile: 'test',
      requestId: randomUUID(),
    });
  scoped(runA).begin('model.request').end();
  await started;
  try {
    scoped(runB).begin('model.request').end();
    expect(observer.incomplete.has(runB)).toBe(true);
  } finally {
    release();
  }
  await observer.flush();
  expect(
    JSON.parse(await readFile(join(directory, 'activity', runB + '.json'), 'utf8')),
  ).toMatchObject({ incomplete: true });
  const restarted = await new ActivityReader(directory).read(runB);
  expect(restarted.index.count).toBe(0);
  expect(restarted.data.partial).toBe(true);
  await observer.close();
});

it.each(['cancel', 'close'] as const)(
  'пауза перестаёт накапливать время после %s',
  async (action) => {
    const { app, run } = await completedRun();
    const reader = new ActivityReader(join(app.directory, 'measurements'));
    let ticks = 0;
    const observer = new ActivityObserver(reader, {
      clock: { monotonic: () => ticks, calendar: () => new Date().toISOString() },
    });
    const lifecycle = new RunObservations(observer);
    await lifecycle.stop({ ...run, status: 'paused' });
    ticks = 30;
    if (action === 'cancel') await lifecycle.stop({ ...run, status: 'cancelled' });
    else await lifecycle.close();
    ticks = 100;
    const { data } = await reader.read(run.id);
    expect(data.pauseMs).toBe(30);
    expect(data.open).toEqual([]);
    const events = (await reader.page(run.id, 0, 100)).events;
    expect(events.find((event) => event.type === 'end')?.outcome).toBe(
      action === 'cancel' ? 'cancelled' : 'interrupted',
    );
    await lifecycle.close();
    expect((await reader.read(run.id)).index.count).toBe(2);
    await observer.close();
  },
);

it('runtime уведомляет измерения при отмене уже остановленной задачи и при закрытии', async () => {
  const { app, run } = await completedRun();
  const stop = vi.spyOn(app.runtime.observations, 'stop');
  const close = vi.spyOn(app.runtime.observations, 'close');
  await app.sessions.mutate(run.id, 'test.paused', {}, (state) => {
    state.status = 'paused';
  });
  await app.runtime.cancel(run.id);
  expect(stop).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: run.id, status: 'cancelled' }),
  );
  await app.runtime.close();
  expect(close).toHaveBeenCalledOnce();
});

it('две тысячи завершённых специалистов читаются страницами в пределах ответа IPC', async () => {
  const { app, run } = await completedRun();
  const original = run.agents[run.rootAgentId]!;
  const entries = Array.from({ length: 2000 }, (_, index) => {
    const id = index ? randomUUID() : run.rootAgentId;
    return {
      ...original,
      id,
      parentId: index ? run.rootAgentId : undefined,
      depth: index ? 1 : 0,
      task: 'я'.repeat(20000),
      result: '界'.repeat(20000),
      error: 'э'.repeat(20000),
    };
  });
  const large = { ...run, agents: Object.fromEntries(entries.map((agent) => [agent.id, agent])) };
  const loaded = vi.spyOn(app.sessions, 'load').mockResolvedValue(large);
  const service = new InsightsService(join(app.directory, 'measurements'), app.sessions);
  try {
    const defaults = insightCommands['runtime.insights'].params.parse({ runId: run.id });
    expect(defaults).toMatchObject({ agentOffset: 0, agentLimit: 50 });
    expect(
      insightCommands['runtime.insights'].params.safeParse({ runId: run.id, agentLimit: 101 })
        .success,
    ).toBe(false);
    const first = await service.report(run.id);
    expect(first.agents).toHaveLength(50);
    expect(first).toMatchObject({ agentOffset: 0, agentTotal: 2000 });
    const page = await service.report(run.id, undefined, 0, 50, 100);
    expect(page.agents).toHaveLength(100);
    expect(page.agents[0]).toMatchObject({
      id: entries[50]!.id,
      parentId: run.rootAgentId,
      depth: 1,
    });
    expect(page.agents.at(-1)?.id).toBe(entries[149]!.id);
    const last = await service.report(run.id, undefined, 0, 1999, 100);
    expect(last.agents).toHaveLength(1);
    const selected = await service.report(run.id, entries[1500]!.id, 16384);
    expect(selected.agents).toHaveLength(1);
    expect(selected.agents[0]).toMatchObject({
      id: entries[1500]!.id,
      resultCursor: 16384,
      result: '界'.repeat(3616),
      resultTruncated: false,
    });
    for (const response of [first, page, last, selected]) {
      expect(runInsightsSchema.safeParse(response).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8 * 1024 * 1024);
    }
  } finally {
    loaded.mockRestore();
    await service.observer.close();
  }
});
