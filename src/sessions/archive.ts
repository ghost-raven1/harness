import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { clone, hash } from '../shared/primitives.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import { syncDirectory } from './files.js';
import { HistoryCache } from './cache.js';
import { catalogEntry, catalogEntrySchema, HistorySearch } from './catalog.js';
import {
  buildIndex,
  indexedPage,
  readIndex,
  saveIndex,
  type JournalIndex,
} from './journal-index.js';
import { JournalReadError, scanJournal } from './journal.js';
import { validateJournalEvent } from './validation.js';
import type { RunRecord, JournalEvent } from './types.js';
import type { RunCatalogEntry } from './ports.js';

/** Файловое чтение и производные данные отделены от последовательной записи и восстановления. */
export class SessionArchive {
  protected readonly runs = new Map<string, RunRecord>();
  protected readonly historical = new HistoryCache<RunRecord>();
  protected readonly pinned = new Set<string>();
  protected readonly entries = new Map<string, RunCatalogEntry>();
  protected readonly indexes = new Map<string, JournalIndex>();
  protected readonly searches: HistorySearch;
  constructor(readonly directory: string) {
    this.searches = new HistorySearch(
      directory,
      (runId) => this.load(runId),
      (run) => this.repairSearch(run),
    );
  }
  /** Владелец записи переопределяет барьер, чтобы поиск не создал файл после удаления. */
  protected repairSearch(run: RunRecord): Promise<void> {
    return this.searches.save(run);
  }
  /** Проверяет индекс либо строит его одним проходом; снимок JSON не заменяет журнал. */
  protected async indexRun(runId: string, repair = false, force = false): Promise<void> {
    const source = this.path(runId),
      target = this.indexPath(runId);
    const saved = force
      ? undefined
      : await readIndex(target, source, (value) => catalogEntrySchema.parse(value));
    if (saved && saved.data.id === runId && saved.data.seq === saved.index.count) {
      this.indexes.set(runId, saved.index);
      this.entries.set(runId, saved.data as RunCatalogEntry);
      // Небольшой прогрев сохраняет удобный доступ к недавним снимкам, не загружая весь архив.
      if (this.entries.size <= 16) await this.load(runId);
      return;
    }
    const validate = (value: unknown, seq: number) => validateJournalEvent(value, seq, runId);
    let rebuilt: Awaited<ReturnType<typeof buildIndex<JournalEvent>>>;
    try {
      rebuilt = await buildIndex(source, validate);
    } catch (error) {
      if (!repair || !(error instanceof JournalReadError) || error.code !== 'JOURNAL_TORN_TAIL')
        throw error;
      const file = await open(source, 'r+');
      try {
        await file.truncate(error.offset);
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(join(this.directory, 'runs'));
      rebuilt = await buildIndex(source, validate);
    }
    if (!rebuilt.last) return;
    const entry = catalogEntry(rebuilt.last.state, rebuilt.index.count);
    this.entries.set(runId, entry);
    this.indexes.set(runId, rebuilt.index);
    this.remember(rebuilt.last.state);
    await this.searches.save(rebuilt.last.state, force);
    await saveIndex(target, rebuilt.index, entry, force);
  }
  /** Возвращает путь источника, созданный только из проверенного идентификатора. */
  protected path(runId: string): string {
    return join(this.directory, 'runs', runId + '.jsonl');
  }
  /** Производные данные живут отдельно и полностью удаляются вместе с задачей. */
  protected indexPath(runId: string): string {
    return join(this.directory, 'indexes', 'runs', runId + '.json');
  }
  /** Активные состояния удерживаются до завершения исполнителей; история ограничена LRU. */
  protected remember(run: RunRecord): void {
    if (this.pinned.has(run.id) || ['running', 'awaiting_approval'].includes(run.status))
      this.runs.set(run.id, run);
    else {
      this.runs.delete(run.id);
      this.historical.set(run.id, run);
    }
  }
  /** Закрепляет состояние на время работы дерева, включая завершающие операции. */
  pin(runId: string): void {
    const run = this.get(runId);
    this.pinned.add(runId);
    this.runs.set(runId, run);
    this.historical.delete(runId);
  }
  /** Возвращает завершённое дерево в ограниченный исторический кэш. */
  unpin(runId: string): void {
    const run = this.runs.get(runId);
    this.pinned.delete(runId);
    if (run) this.remember(run);
  }
  /** Загружает только последнее состояние выбранного запуска, не всю переписку событий. */
  async load(runId: string): Promise<RunRecord> {
    const entry = this.entries.get(runId);
    if (!entry) throw new ResourceNotFoundError('task');
    const cached = this.runs.get(runId) ?? this.historical.get(runId);
    if (cached) return clone(cached);
    const index = this.indexes.get(runId)!;
    for await (const row of scanJournal(this.path(runId), index.lastOffset)) {
      const event = validateJournalEvent(row.value, index.count, runId);
      // Пока читался диск, запись или удаление могли сменить поколение каталога.
      if (this.entries.get(runId) !== entry) return this.load(runId);
      this.remember(event.state);
      return clone(event.state);
    }
    throw new Error('JOURNAL_MISSING_STATE');
  }
  /** Каталог не содержит переписку и не читает журналы при построении меню. */
  catalog(includeDeleted = false): RunCatalogEntry[] {
    return [...this.entries.values()]
      .filter((run) => includeDeleted || !run.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }
  /** Возвращает совпадения по полным задачам и ответам из отдельных поисковых данных. */
  async search(query: string, includeDeleted = false): Promise<Set<string>> {
    const matched = await this.searches.match([...this.entries.values()], query);
    return new Set(
      [...this.entries.values()]
        .filter((entry) => (includeDeleted || !entry.deletedAt) && matched.has(entry.id))
        .map((entry) => entry.id),
    );
  }
  /** Показывает только размер и предел исторического кэша. */
  cacheStats() {
    return this.historical.stats();
  }
  /** Совместимый доступ к уже загруженным снимкам; прикладные списки используют каталог. */
  list(includeDeleted = false): RunRecord[] {
    return this.catalog(includeDeleted).map((entry) => this.get(entry.id));
  }
  /** Синхронно читает только закреплённое или недавно загруженное состояние. */
  get(runId: string): RunRecord {
    const run = this.runs.get(runId) ?? this.historical.get(runId);
    if (!run) {
      if (!this.entries.has(runId)) throw new ResourceNotFoundError('task');
      throw new Error('Historical state must be loaded asynchronously before use');
    }
    return clone(run);
  }
  /** Читает страницу от ближайшего смещения, не собирая полную историю в память. */
  async history(runId: string, after: number, limit = 100): Promise<JournalEvent[]> {
    const index = this.indexes.get(runId);
    if (!index) return [];
    return indexedPage(this.path(runId), index, after, limit, (value, seq) =>
      validateJournalEvent(value, seq, runId),
    );
  }
  /** Связывает подготовленный контекст с версиями всех этапов беседы, включая скрытые. */
  sessionRevision(sessionId: string): string {
    return hash(
      [...this.entries.values()]
        .filter((run) => run.sessionId === sessionId)
        .map((run) => [run.id, this.entries.get(run.id)?.seq ?? 0] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
}
