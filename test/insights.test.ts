import { randomUUID } from 'node:crypto';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ActivityObserver } from '../src/insights/observer.js';
import { ActivityReader } from '../src/insights/reader.js';
import { materialize } from '../src/insights/aggregate.js';
import { temporary } from './helpers.js';

/** Управляемые часы позволяют отличить календарный скачок от прошедшего времени. */
async function fixture(maximumBytes?: number) {
  const directory = await temporary();
  let ticks = 0;
  let wall = '2026-01-01T00:00:00.000Z';
  const reader = new ActivityReader(directory);
  const observer = new ActivityObserver(reader, {
    maximumBytes,
    clock: { monotonic: () => ticks, calendar: () => wall },
  });
  const scope = {
    runId: randomUUID(),
    agentId: randomUUID(),
    role: 'coordinator',
    profile: 'test',
    requestId: randomUUID(),
  };
  return {
    directory,
    reader,
    observer,
    scope,
    observation: observer.scope(scope),
    advance: (value: number) => {
      ticks += value;
    },
    calendar: (value: string) => {
      wall = value;
    },
  };
}

describe('Измерения исполнения', () => {
  it('считает время дерева один раз, независимо от параллельных ролей и перевода часов', async () => {
    const f = await fixture();
    const run = f.observation.begin('run');
    const agent = f.observation.begin('agent');
    const child = f.observer
      .scope({ ...f.scope, agentId: randomUUID(), role: 'executor' })
      .begin('agent');
    f.advance(2000);
    f.calendar('2025-01-01T00:00:00.000Z');
    child.end();
    agent.end();
    run.end();
    await f.observer.flush();
    const { data } = await f.reader.read(f.scope.runId);
    expect(data.activeMs).toBe(2000);
    expect(data.roles.reduce((sum, role) => sum + (role.phases.agent ?? 0), 0)).toBe(4000);
    expect(data.partial).toBe(false);
  });
  it('новая роль того же агента имеет отдельный участок; повторный end не меняет итог', async () => {
    const f = await fixture();
    const first = f.observation.begin('agent');
    f.advance(5);
    first.end();
    first.end();
    const second = f.observer.scope({ ...f.scope, role: 'reviewer' }).begin('agent');
    f.advance(10);
    second.end();
    await f.observer.flush();
    const { data } = await f.reader.read(f.scope.runId);
    expect(data.roles.map((item) => item.phases.agent)).toEqual([5, 10]);
    expect(new Set(data.roles.map((item) => item.episodeId)).size).toBe(2);
  });
  it('не подменяет неизвестный расход нулём и не суммирует повторное уведомление попытки', async () => {
    const f = await fixture();
    f.observation.usage({ input: 7, output: 4, source: 'provider' }, { attempt: 1 });
    f.observation.usage({ input: 7, output: 4, source: 'provider' }, { attempt: 1 });
    f.observation.usage({ input: null, output: null, source: 'unavailable' }, { attempt: 2 });
    f.observation.usage({ input: 10, output: 5, source: 'estimate' }, { attempt: 3 });
    await f.observer.flush();
    expect((await f.reader.read(f.scope.runId)).data.usage).toEqual({
      provider: { input: 7, output: 4, requests: 1 },
      estimate: { input: 10, output: 5, requests: 1 },
      unavailable: 1,
    });
  });
  it('продолжает запись после отсутствующего первого фрагмента в неуспешной попытке', async () => {
    const f = await fixture();
    f.observation.begin('model.first_output', { attempt: 1 }).end('interrupted');
    await f.observer.flush();
    f.observation.begin('model.request', { attempt: 2 }).end();
    f.observation.usage({ input: 1, output: 2, source: 'provider' }, { attempt: 2 });
    await f.observer.flush();
    const { data } = await f.reader.read(f.scope.runId);
    expect(data.count).toBe(5);
    expect(data.usage.provider.requests).toBe(1);
  });
  it('незакрытый интервал после рестарта прерван, простой сервиса не прибавляется', async () => {
    const f = await fixture();
    f.observation.begin('model.request');
    f.advance(42);
    await f.observer.flush();
    const before = (await f.reader.read(f.scope.runId)).data;
    expect(
      materialize(before, (id) => f.observer.elapsed(id)).roles[0]!.phases['model.request'],
    ).toBe(42);
    const reader = new ActivityReader(f.directory);
    const restored = materialize((await reader.read(f.scope.runId)).data, () => undefined);
    expect(restored.partial).toBe(true);
    expect(restored.roles[0]!.interrupted).toBe(1);
    expect(restored.roles[0]!.phases['model.request']).toBeUndefined();
  });
  it('оборванный хвост не ремонтируется читателем и запрещает последующее дописывание', async () => {
    const f = await fixture();
    f.observation.begin('agent').end();
    await f.observer.flush();
    const source = f.reader.path(f.scope.runId);
    await appendFile(source, '{"broken":');
    const bytes = await readFile(source);
    expect((await f.reader.read(f.scope.runId)).data.partial).toBe(true);
    expect(await readFile(source)).toEqual(bytes);
    f.observation.begin('agent').end();
    await f.observer.flush();
    expect(await readFile(source)).toEqual(bytes);
    expect(f.observer.incomplete.has(f.scope.runId)).toBe(true);
  });
  it('потерю событий при переполнении сохраняет отдельно и не останавливает работу', async () => {
    const f = await fixture(1);
    f.observation.begin('agent').end();
    expect(f.observer.incomplete.has(f.scope.runId)).toBe(true);
    await f.observer.flush();
    expect((await new ActivityReader(f.directory).read(f.scope.runId)).data.partial).toBe(true);
  });
  it('отказ записи не выбрасывается исполнителю; неполнота видна после повторного открытия', async () => {
    const f = await fixture();
    const writer = new ActivityObserver(f.reader, {
      append: async () => {
        throw new Error('ENOSPC');
      },
    });
    writer.scope(f.scope).begin('tool.execute').end();
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(writer.incomplete.has(f.scope.runId)).toBe(true);
    expect((await new ActivityReader(f.directory).read(f.scope.runId)).data.partial).toBe(true);
  });
  it('пагинация, фильтр и восстановление индекса не загружают всю временную линию в ответ', async () => {
    const f = await fixture();
    for (let i = 0; i < 180; i++) f.observation.begin('tool.execute').end();
    await f.observer.flush();
    let page = await f.reader.page(f.scope.runId, 250, 20, f.scope.agentId);
    expect(page.events).toHaveLength(20);
    expect(page.events[0]!.seq).toBe(251);
    expect(page.hasMore).toBe(true);
    await writeFile(join(f.directory, 'indexes/activity', f.scope.runId + '.json'), 'broken');
    page = await new ActivityReader(f.directory).page(f.scope.runId, 350, 100);
    expect(page.events).toHaveLength(10);
    expect(page.hasMore).toBe(false);
    expect(f.reader.cache.stats().bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
  it('сводка с диска сохраняет маркер неполноты при пригодном индексе', async () => {
    const f = await fixture();
    f.observation.begin('agent').end();
    await f.observer.flush();
    await writeFile(join(f.directory, 'activity', f.scope.runId + '.json'), '{"incomplete":true}');
    expect((await new ActivityReader(f.directory).read(f.scope.runId)).data.partial).toBe(true);
  });
  it('чтение старой задачи не создаёт журнал, индекс и фиктивный usage', async () => {
    const f = await fixture();
    const data = await f.reader.read(f.scope.runId);
    expect(data.index.count).toBe(0);
    await expect(readFile(f.reader.path(f.scope.runId))).rejects.toHaveProperty('code', 'ENOENT');
    expect((await f.reader.page(f.scope.runId, 0, 100)).completeness).toBe('unavailable');
  });
  it('удаление очищает кэш и не восстанавливает старые метрики из него', async () => {
    const f = await fixture();
    f.observation.begin('agent').end();
    await f.observer.flush();
    await f.observer.forget([f.scope.runId]);
    await rm(f.reader.path(f.scope.runId));
    expect(f.reader.cache.stats().entries).toBe(0);
    expect((await f.reader.read(f.scope.runId)).data.count).toBe(0);
  });
});
