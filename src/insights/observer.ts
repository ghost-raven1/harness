import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { atomicJson, assertRealDirectory } from '../sessions/files.js';
import { appendJournalBatch } from '../sessions/journal.js';
import { appendedIndex, saveIndex } from '../sessions/journal-index.js';
import type { ExecutionObserver, ExecutionObservation, ObservationScope } from './ports.js';
import { activityEventSchema, type ActivityEvent } from './schema.js';
import { accumulate } from './aggregate.js';
import { ActivityReader } from './reader.js';

interface PendingEvent {
  event: ActivityEvent;
  bytes: number;
}
interface Clock {
  monotonic(): number;
  calendar(): string;
}
const clock: Clock = {
  monotonic: () => performance.now(),
  calendar: () => new Date().toISOString(),
};

/** Наблюдатель имеет ограниченную очередь и никогда не меняет исход основной операции. */
export class ActivityObserver implements ExecutionObserver {
  readonly processId = randomUUID();
  readonly incomplete = new Set<string>();
  private readonly active = new Map<string, { start: number; runId: string }>();
  private readonly episodes = new Map<string, { role: string; profile: string; id: string }>();
  private queue: PendingEvent[] = [];
  private bytes = 0;
  private readonly gaps = new Set<string>();
  private draining?: Promise<void>;
  private closed = false;
  constructor(
    readonly reader: ActivityReader,
    private readonly options: {
      maximumBytes?: number;
      clock?: Clock;
      append?: typeof appendJournalBatch;
    } = {},
  ) {}
  /** Привязывает роль к участку работы агента; handoff начинает новый участок. */
  scope(scope: ObservationScope): ExecutionObservation {
    const key = scope.runId + ':' + scope.agentId;
    let episode = this.episodes.get(key);
    if (!episode || episode.role !== scope.role || episode.profile !== scope.profile) {
      episode = { role: scope.role, profile: scope.profile, id: randomUUID() };
      this.episodes.set(key, episode);
    }
    const episodeId = episode.id;
    const used = new Set<number>();
    const timing = this.options.clock ?? clock;
    const base = (): ActivityEvent => ({
      ...scope,
      schemaVersion: 1,
      seq: 0,
      at: timing.calendar(),
      processId: this.processId,
      episodeId,
      type: 'gap',
    });
    return {
      begin: (phase, details = {}) => {
        const spanId = randomUUID(),
          start = timing.monotonic();
        this.active.set(spanId, { start, runId: scope.runId });
        this.enqueue({ ...base(), ...details, type: 'start', phase, spanId });
        let ended = false;
        return {
          end: (outcome = 'completed') => {
            if (ended) return;
            ended = true;
            this.active.delete(spanId);
            this.enqueue({
              ...base(),
              ...details,
              type: 'end',
              phase,
              spanId,
              outcome,
              durationMs: Math.max(0, timing.monotonic() - start),
            });
          },
        };
      },
      usage: (usage, details = {}) => {
        const attempt = details.attempt ?? 1;
        if (used.has(attempt)) return;
        used.add(attempt);
        this.enqueue({ ...base(), ...details, attempt, type: 'usage', usage });
      },
    };
  }
  /** Текущая длительность существует только для живого интервала данного процесса. */
  elapsed(spanId: string): number | undefined {
    const span = this.active.get(spanId);
    return span ? Math.max(0, (this.options.clock ?? clock).monotonic() - span.start) : undefined;
  }
  /** Дожидается подтверждения измерений; ошибка остаётся признаком неполного отчёта. */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }
  /** Останавливает запись после завершения исполнителей. */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.active.clear();
    this.episodes.clear();
  }
  /** Удаление ждёт записи, затем очищает все ссылки на удалённые запуски. */
  async forget(runIds: string[]): Promise<void> {
    await this.flush();
    const ids = new Set(runIds);
    for (const id of ids) this.incomplete.delete(id);
    for (const [key, value] of this.active) if (ids.has(value.runId)) this.active.delete(key);
    for (const key of this.episodes.keys())
      if (ids.has(key.slice(0, 36))) this.episodes.delete(key);
    await this.reader.forget(runIds);
  }
  /** Освобождает участки завершённого дерева, не теряя открытые паузы. */
  release(runId: string): void {
    for (const key of this.episodes.keys())
      if (key.startsWith(runId + ':')) this.episodes.delete(key);
  }
  private enqueue(value: ActivityEvent): void {
    if (this.closed) return;
    const parsed = activityEventSchema.safeParse(value);
    if (!parsed.success) {
      this.markIncomplete(value.runId);
      return;
    }
    const event = parsed.data;
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 32;
    if (this.bytes + bytes > (this.options.maximumBytes ?? 1024 * 1024)) {
      this.markIncomplete(event.runId);
      return;
    }
    this.bytes += bytes;
    this.queue.push({ event, bytes });
    this.startDrain();
  }
  private startDrain(): void {
    this.draining ??= Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.draining = undefined;
        if (this.queue.length || this.gaps.size) this.startDrain();
      });
  }
  private markIncomplete(runId: string): void {
    this.incomplete.add(runId);
    this.gaps.add(runId);
    this.startDrain();
  }
  private async drain(): Promise<void> {
    while (this.queue.length || this.gaps.size) {
      const batch = this.queue;
      this.queue = [];
      const groups = new Map<string, ActivityEvent[]>();
      for (const item of batch) {
        const events = groups.get(item.event.runId) ?? [];
        events.push(item.event);
        groups.set(item.event.runId, events);
      }
      for (const runId of this.gaps) if (!groups.has(runId)) groups.set(runId, []);
      this.gaps.clear();
      for (const [runId, events] of groups) {
        try {
          await assertRealDirectory(join(this.reader.directory, 'activity'));
          if (events.length) {
            const saved = await this.reader.read(runId);
            if (saved.corrupt) throw new Error('Измерения требуют нового журнала');
            let seq = saved.index.count;
            for (const event of events) event.seq = ++seq;
            await (this.options.append ?? appendJournalBatch)(this.reader.path(runId), events);
            const data = structuredClone(saved.data);
            for (const event of events) accumulate(data, event);
            const index = await appendedIndex(this.reader.path(runId), saved.index, events);
            this.reader.cache.set(runId, { index, data });
            await saveIndex(
              join(this.reader.directory, 'indexes/activity', runId + '.json'),
              index,
              data,
            );
          }
        } catch {
          this.incomplete.add(runId);
        }
        if (this.incomplete.has(runId)) {
          // Маркер переживает рестарт; если диск недоступен, незакрытые фазы также показывают пробел.
          await atomicJson(join(this.reader.directory, 'activity', runId + '.json'), {
            incomplete: true,
          }).catch(() => undefined);
          this.reader.cache.delete(runId);
        }
      }
      this.bytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
    }
  }
}
