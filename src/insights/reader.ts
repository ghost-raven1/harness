import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { HistoryCache } from '../sessions/cache.js';
import { assertRealDirectory, optionalJson } from '../sessions/files.js';
import { scanJournal } from '../sessions/journal.js';
import { readIndex, saveIndex, type JournalIndex } from '../sessions/journal-index.js';
import { accumulate, emptyAggregate } from './aggregate.js';
import {
  activityAggregateSchema,
  activityEventSchema,
  type ActivityEvent,
  type ActivityAggregate,
} from './schema.js';

export interface ActivityData {
  index: JournalIndex;
  data: ActivityAggregate;
  corrupt?: boolean;
}

/** Читает технический журнал и перестраивает только производные смещения и сводку. */
export class ActivityReader {
  readonly cache = new HistoryCache<ActivityData>(16 * 1024 * 1024);
  private readonly pending = new Map<string, Promise<ActivityData>>();
  constructor(readonly directory: string) {}
  /** Служебный путь строится только после проверки идентификатора запуска. */
  path(runId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Некорректный идентификатор измерений');
    return join(this.directory, 'activity', runId + '.jsonl');
  }
  /** Объединяет одновременное чтение одного источника; неизменный журнал обслуживается кэшем. */
  async read(runId: string): Promise<ActivityData> {
    const existing = this.pending.get(runId);
    if (existing) return existing;
    const work = this.load(runId)
      .catch(
        (): ActivityData => ({
          index: {
            schemaVersion: 1,
            size: 0,
            mtimeMs: 0,
            ctimeMs: 0,
            count: 0,
            lastOffset: 0,
            positions: [],
          },
          data: { ...emptyAggregate(), partial: true },
          corrupt: true,
        }),
      )
      .finally(() => this.pending.delete(runId));
    this.pending.set(runId, work);
    return work;
  }
  /** Удаление очищает сводку после завершения уже начатых читателей. */
  async forget(runIds: string[]): Promise<void> {
    await Promise.allSettled(runIds.map((id) => this.pending.get(id)));
    for (const id of runIds) this.cache.delete(id);
  }
  private async load(runId: string): Promise<ActivityData> {
    await assertRealDirectory(join(this.directory, 'activity'));
    await assertRealDirectory(join(this.directory, 'indexes'));
    await assertRealDirectory(join(this.directory, 'indexes/activity'));
    const source = this.path(runId);
    const meta = await stat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return { size: 0, mtimeMs: 0, ctimeMs: 0 };
      throw error;
    });
    const incomplete = !!(await optionalJson(
      join(this.directory, 'activity', runId + '.json'),
    ).catch(() => true));
    const cached = this.cache.get(runId);
    if (cached && incomplete) cached.data.partial = true;
    if (
      cached &&
      cached.index.size === meta.size &&
      cached.index.mtimeMs === meta.mtimeMs &&
      cached.index.ctimeMs === meta.ctimeMs
    )
      return cached;
    const indexPath = join(this.directory, 'indexes/activity', runId + '.json');
    const saved = await readIndex(indexPath, source, (value) =>
      activityAggregateSchema.parse(value),
    );
    if (saved) {
      if (incomplete) saved.data.partial = true;
      this.cache.set(runId, saved);
      return saved;
    }
    const data = emptyAggregate();
    const index: JournalIndex = {
      schemaVersion: 1,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      ctimeMs: meta.ctimeMs,
      count: 0,
      lastOffset: 0,
      positions: [],
    };
    let corrupt = false;
    try {
      for await (const row of scanJournal(source, 0, 32768)) {
        const event = this.validate(runId, row.value, index.count + 1);
        if (index.count % 128 === 0)
          index.positions.push({ seq: index.count + 1, offset: row.offset });
        index.count++;
        index.lastOffset = row.offset;
        accumulate(data, event);
      }
    } catch {
      data.partial = true;
      corrupt = true;
    }
    if (incomplete) data.partial = true;
    const result = { index, data, corrupt };
    // Повреждение журнала не превращается в пригодный для дописывания индекс.
    if (!corrupt && index.count) await saveIndex(indexPath, index, data);
    this.cache.set(runId, result);
    return result;
  }
  /** Проверяет цепочку запуска и последовательность, не пропуская повреждённые строки. */
  validate(runId: string, value: unknown, seq: number): ActivityEvent {
    const event = activityEventSchema.parse(value);
    if (event.runId !== runId || event.seq !== seq)
      throw new Error('Повреждена последовательность измерений');
    return event;
  }
  /** Страница использует разреженные смещения; фильтр не загружает историю целиком. */
  async page(runId: string, cursor: number, limit: number, agentId?: string) {
    const { index, data } = await this.read(runId);
    const events: ActivityEvent[] = [];
    let position = Math.min(cursor, index.count);
    if (position < index.count) {
      const start = index.positions[Math.floor(position / 128)]!;
      let seq = start.seq;
      try {
        for await (const row of scanJournal(this.path(runId), start.offset, 32768)) {
          const event = this.validate(runId, row.value, seq++);
          if (event.seq <= cursor) continue;
          position = event.seq;
          if (!agentId || event.agentId === agentId) events.push(event);
          if (events.length >= limit || position >= index.count) break;
        }
      } catch {
        data.partial = true;
      }
    }
    return {
      events,
      cursor: position,
      hasMore: position < index.count,
      completeness: data.partial
        ? ('partial' as const)
        : !index.count
          ? ('unavailable' as const)
          : ('complete' as const),
    };
  }
}
