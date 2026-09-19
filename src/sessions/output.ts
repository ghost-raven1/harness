import { readdir, open, stat } from 'node:fs/promises';
import type { IndexRebuildReport } from '../diagnostics/history-types.js';
import {
  buildIndex,
  indexedPage,
  readIndex,
  saveIndex,
  type JournalIndex,
} from './journal-index.js';
import { syncDirectory } from './files.js';
import { join } from 'node:path';
import { z } from 'zod';
import { id, Serial } from '../shared/primitives.js';
import type { ModelOutput, ModelProgress } from '../providers/types.js';
import { appendJournalBatch, JournalReadError } from './journal.js';

export const outputEventSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  role: z.string(),
  type: z.enum(['started', 'text', 'reasoning', 'retry', 'completed', 'failed', 'truncated']),
  text: z.string().max(4096).optional(),
});
export type OutputEvent = z.infer<typeof outputEventSchema>;
type NewEvent = Omit<OutputEvent, 'seq'>;

/** Поток интерфейса хранится отдельно: фрагменты текста не копируют снимок всего запуска. */
export class RunOutputStore {
  private readonly indexes = new Map<string, JournalIndex>();
  private readonly serial = new Serial();
  private readonly removed = new Set<string>();
  constructor(private readonly directory: string) {}
  /** Пропускает диагностику между подтверждёнными пачками без остановки модели. */
  withReadBarrier<T>(work: () => Promise<T>): Promise<T> {
    return this.serial.run(work);
  }
  /** Убирает поток из памяти после остановки всех писателей удаляемой беседы. */
  forget(runIds: string[]): Promise<void> {
    return this.serial.run(async () => {
      for (const runId of runIds) {
        this.indexes.delete(runId);
        this.removed.add(runId);
      }
    });
  }
  /** Формирует имя отдельного журнала опубликованного вывода задачи. */
  private path(runId: string): string {
    return join(this.directory, 'output', runId + '.jsonl');
  }
  /** Индекс вывода содержит только номера и смещения; опубликованный текст остаётся в журнале. */
  private indexPath(runId: string): string {
    return join(this.directory, 'indexes', 'output', runId + '.json');
  }
  /** Проверяет схему и непрерывность последовательности вывода. */
  private validate(value: unknown, seq: number): OutputEvent {
    const event = outputEventSchema.parse(value);
    if (event.seq !== seq) throw new Error('JOURNAL_INVALID_SEQUENCE');
    return event;
  }
  /** Загружает метаданные или строит индекс одним проходом. */
  private async load(runId: string, repair = false, force = false): Promise<JournalIndex> {
    if (!force && this.indexes.has(runId)) return this.indexes.get(runId)!;
    const saved = force
      ? undefined
      : await readIndex(this.indexPath(runId), this.path(runId), () => null);
    if (saved) {
      this.indexes.set(runId, saved.index);
      return saved.index;
    }
    let rebuilt;
    try {
      rebuilt = await buildIndex(this.path(runId), this.validate);
    } catch (error) {
      if (!repair || !(error instanceof JournalReadError) || error.code !== 'JOURNAL_TORN_TAIL')
        throw error;
      const file = await open(this.path(runId), 'r+');
      try {
        await file.truncate(error.offset);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(join(this.directory, 'output'));
      rebuilt = await buildIndex(this.path(runId), this.validate);
    }
    this.indexes.set(runId, rebuilt.index);
    await saveIndex(this.indexPath(runId), rebuilt.index, null, force);
    return rebuilt.index;
  }
  /** Проверяет журналы вывода до запуска исполнителей; ремонт разрешает только владелец. */
  async initialize(repair = true, removed: ReadonlySet<string> = new Set()): Promise<void> {
    for (const runId of removed) this.removed.add(runId);
    for (const name of await this.names()) await this.load(name.slice(0, -6), repair);
  }
  /** Перечисляет существующие потоки без создания каталога. */
  private async names(): Promise<string[]> {
    try {
      return (await readdir(join(this.directory, 'output'))).filter(
        (name) => /^[a-f0-9-]{36}\.jsonl$/.test(name) && !this.removed.has(name.slice(0, -6)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  /** Перестраивает исключительно смещения; исходные записи не меняются. */
  rebuildIndex(): Promise<IndexRebuildReport> {
    return this.serial.run(async () => {
      let rebuilt = 0,
        skipped = 0;
      const issues: IndexRebuildReport['issues'] = [];
      for (const name of await this.names()) {
        try {
          await this.load(name.slice(0, -6), false, true);
          rebuilt++;
        } catch {
          skipped++;
          issues.push({ code: 'INDEX_REBUILD_FAILED', kind: 'output' });
        }
      }
      return { checkedAt: new Date().toISOString(), rebuilt, skipped, issues };
    });
  }
  /** Читает одну страницу с ближайшего смещения без кэша полных потоков. */
  page(
    runId: string,
    cursor: number,
  ): Promise<{ events: OutputEvent[]; cursor: number; hasMore: boolean }> {
    return this.serial.run(async () => {
      const index = await this.load(runId);
      const events = await indexedPage(this.path(runId), index, cursor, 32, this.validate);
      const next = events.at(-1)?.seq ?? cursor;
      return { events, cursor: next, hasMore: index.count > next };
    });
  }
  /** Обновляет смещения только после подтверждения всей пачки; отказ индекса не отменяет запись. */
  append(runId: string, events: NewEvent[]): Promise<void> {
    return this.serial.run(async () => {
      const previous = await this.load(runId);
      const rows = events.map((event, index) => ({ ...event, seq: previous.count + index + 1 }));
      await appendJournalBatch(this.path(runId), rows);
      const index = { ...previous, positions: [...previous.positions] };
      for (const row of rows) {
        if (index.count % 128 === 0) index.positions.push({ seq: row.seq, offset: index.size });
        index.lastOffset = index.size;
        index.size += Buffer.byteLength(JSON.stringify(row) + '\n');
        index.count++;
      }
      this.indexes.set(runId, index);
      try {
        const meta = await stat(this.path(runId));
        index.mtimeMs = meta.mtimeMs;
        index.ctimeMs = meta.ctimeMs;
      } catch {
        /* Перестроение при следующем чтении. */
      }
      await saveIndex(this.indexPath(runId), index, null);
    });
  }
  /** Открывает отдельную запись потока для запроса модели в выбранной роли. */
  async begin(runId: string, agentId: string, role: string): Promise<ModelOutputWriter> {
    const writer = new ModelOutputWriter(this, runId, agentId, role);
    await writer.start();
    return writer;
  }
}

/** Объединяет токены в пачки; остановка модели дожидается записи последнего фрагмента. */
export class ModelOutputWriter {
  readonly requestId = id();
  private pending: NewEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: unknown;
  private readonly serial = new Serial();
  private readonly length = { text: 0, reasoning: 0 };
  private readonly seen = { text: false, reasoning: false };
  private clipped = false;
  private closed = false;
  constructor(
    private readonly store: RunOutputStore,
    private readonly runId: string,
    private readonly agentId: string,
    private readonly role: string,
  ) {}
  /** Создаёт метаданные фрагмента, сохраняя связь с запросом и агентом. */
  private event(type: OutputEvent['type'], text?: string): NewEvent {
    return {
      at: new Date().toISOString(),
      requestId: this.requestId,
      agentId: this.agentId,
      role: this.role,
      type,
      ...(text === undefined ? {} : { text }),
    };
  }
  /** Записывает начало запроса до появления первых фрагментов ответа. */
  async start(): Promise<void> {
    await this.store.append(this.runId, [this.event('started')]);
  }
  /** Накапливает опубликованные фрагменты с ограничением предпросмотра и отложенной записью. */
  progress = (event: ModelProgress): void => {
    if (this.closed) return;
    if (event.type === 'retry') {
      this.pending.push(this.event('retry', 'Повтор подключения: попытка ' + event.attempt));
      this.seen.text = this.seen.reasoning = false;
    } else {
      if (!event.text) return;
      this.seen[event.type] = true;
      const text = event.text.slice(0, Math.max(0, 65536 - this.length[event.type]));
      this.length[event.type] += text.length;
      for (let offset = 0; offset < text.length; offset += 4096) {
        const last = this.pending.at(-1),
          chunk = text.slice(offset, offset + 4096);
        if (last?.type === event.type && (last.text?.length ?? 0) + chunk.length <= 4096)
          last.text = (last.text ?? '') + chunk;
        else this.pending.push(this.event(event.type, chunk));
      }
      if (text.length < event.text.length && !this.clipped) {
        this.clipped = true;
        this.pending.push(
          this.event(
            'truncated',
            'Достигнут лимит предпросмотра. Итоговый ответ сохраняется отдельно.',
          ),
        );
      }
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => {
        this.failure = error;
      });
    }, 150);
  };
  /** Последовательно записывает накопленную пачку, отделяя её от новых фрагментов. */
  private flush(): Promise<void> {
    const batch = this.pending.splice(0);
    return this.serial.run(async () => {
      if (batch.length) await this.store.append(this.runId, batch);
    });
  }
  /** Закрывает поток, дописывает остаток и сообщает об ошибке сохранения. */
  async finish(output?: ModelOutput): Promise<void> {
    if (output) {
      if (!this.seen.text && output.text) this.progress({ type: 'text', text: output.text });
      if (!this.seen.reasoning && output.reasoning)
        this.progress({ type: 'reasoning', text: output.reasoning });
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.push(this.event(output ? 'completed' : 'failed'));
    await this.flush();
    if (this.failure) throw this.failure;
  }
}
