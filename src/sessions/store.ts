import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { clone, hash, id, message, Serial } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import { SessionChangedError } from '../shared/session-conflict.js';
import { writeSnapshot, assertRealDirectory } from './files.js';
import { appendJournal } from './journal.js';
import { FileStateFiles } from './state-files.js';
import { catalogEntry } from './catalog.js';
import { SessionArchive } from './archive.js';
import { saveIndex, type JournalIndex } from './journal-index.js';
import { validateRunRecord } from './validation.js';
import type { SessionStore } from './ports.js';
import { verifyHistory } from '../diagnostics/history-verification.js';
import type { IndexRebuildReport } from '../diagnostics/history-types.js';
import type { RunRecord, JournalEvent } from './types.js';
import { RunOutputStore } from './output.js';
import { assertKnownSessionOutcomes, latestSessionRun } from './continuation.js';
import {
  readPurgeRecords,
  removeRunFiles,
  writePurgeRecord,
  type PurgeRecord,
} from './purge-records.js';

/** Хранилище с одним писателем; синхронизированный журнал важнее снимков. */
export class FileSessionStore extends SessionArchive implements SessionStore {
  private readonly serial = new Serial();
  private readonly purged = new Map<string, PurgeRecord>();
  private maintenance = false;
  private recoveryFailure?: string;
  readonly output: RunOutputStore;
  readonly stateFiles: FileStateFiles;
  constructor(directory: string) {
    super(directory);
    this.stateFiles = new FileStateFiles(directory);
    this.output = new RunOutputStore(directory);
  }
  /** Загружает каталог; только владелец состояния может исправить оборванный хвост. */
  async initialize(options: { recover?: boolean } = {}): Promise<void> {
    try {
      for (const name of ['runs', 'output', 'indexes', 'indexes/runs', 'indexes/output', 'search'])
        await assertRealDirectory(join(this.directory, name));
    } catch (error) {
      this.requireRecovery(error);
      return;
    }
    try {
      for (const record of await readPurgeRecords(this.directory))
        this.purged.set(record.sessionId, record);
    } catch (error) {
      this.requireRecovery(error);
      return;
    }
    const removed = new Set([...this.purged.values()].flatMap((record) => record.runIds));
    await mkdir(join(this.directory, 'runs'), { recursive: true, mode: 0o700 });
    for (const name of await readdir(join(this.directory, 'runs'))) {
      if (!name.endsWith('.jsonl') || removed.has(name.slice(0, -6))) continue;
      const runId = name.slice(0, -6);
      if (!/^[a-f0-9-]{36}$/.test(runId)) {
        this.requireRecovery(new Error('JOURNAL_INVALID_ID'));
        continue;
      }
      try {
        await this.indexRun(runId, options.recover !== false);
      } catch (error) {
        this.requireRecovery(error);
      }
    }
    try {
      for (const entry of this.catalog(true)) {
        if (entry.parentRunId) {
          const parent = this.entries.get(entry.parentRunId);
          if (
            !parent ||
            parent.sessionId !== entry.sessionId ||
            parent.workspace !== entry.workspace
          )
            throw new Error('JOURNAL_INVALID_REFERENCE');
        }
      }
      latestSessionRun(this.catalog(true));
    } catch (error) {
      this.requireRecovery(error);
    }
    try {
      await this.output.initialize(options.recover !== false, removed);
    } catch (error) {
      this.requireRecovery(error);
    }
    if (!this.recoveryError && options.recover !== false) {
      for (const entry of this.catalog(true)) {
        if (['running', 'awaiting_approval'].includes(entry.status) || entry.unfinishedOperations)
          await this.recoverInterrupted(entry.id);
      }
    }
  }
  /** Согласует ремонт поискового файла с изменением задачи и каскадным удалением. */
  protected override repairSearch(run: RunRecord): Promise<void> {
    return this.serial.run(async () => {
      if (
        this.purgeRecord(run.id) ||
        this.entries.get(run.id)?.searchHash !== catalogEntry(run, 1).searchHash
      )
        return;
      await this.searches.save(run);
    });
  }
  /** Проверяет источники последовательно с записью, не изменяя их. */
  verifyHistory(barrier: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()) {
    return this.serial.run(() =>
      this.output.withReadBarrier(() =>
        barrier(async () => {
          const report = await verifyHistory(this.directory);
          if (!report.healthy)
            this.requireRecovery(new Error(report.issues[0]?.code ?? 'STORAGE_UNAVAILABLE'));
          return report;
        }),
      ),
    );
  }
  /** Перестраивает только производные данные под блокировкой владельца сервиса. */
  rebuildIndex(): Promise<IndexRebuildReport> {
    return this.serial.run(async () => {
      let rebuilt = 0,
        skipped = 0;
      const issues: IndexRebuildReport['issues'] = [];
      for (const name of await readdir(join(this.directory, 'runs'))) {
        const runId = name.slice(0, -6);
        if (!name.endsWith('.jsonl') || this.purgeRecord(runId)) continue;
        try {
          await this.indexRun(runId, false, true);
          rebuilt++;
        } catch {
          skipped++;
          issues.push({ code: 'INDEX_REBUILD_FAILED', kind: 'run' });
        }
      }
      const output = await this.output.rebuildIndex();
      rebuilt += output.rebuilt;
      skipped += output.skipped;
      issues.push(...output.issues);
      this.searches.invalidate();
      return { checkedAt: new Date().toISOString(), rebuilt, skipped, issues };
    });
  }
  /** Вызывается после остановки исполнителей; статус паузы сам по себе не доказывает завершение записи. */
  async recoverInterrupted(runId: string): Promise<void> {
    const run = await this.load(runId);
    const active = (state: RunRecord): boolean =>
      ['running', 'awaiting_approval'].includes(state.status);
    if (!active(run) && !Object.values(run.invocations).some((item) => item.status === 'started'))
      return;
    await this.mutate(runId, 'run.recovered', {}, (state) => {
      if (active(state)) state.status = 'paused';
      for (const invocation of Object.values(state.invocations)) {
        if (invocation.status !== 'started') continue;
        invocation.status = invocation.effect === 'write' ? 'unknown' : 'error';
        invocation.result = JSON.stringify({
          error: 'Invocation interrupted before result was saved',
        });
        invocation.error = 'Execution stopped after invocation started; outcome is unknown';
      }
    });
  }
  /** Сохраняет новый запуск только при неизменном контексте и проверенных исходах операций. */
  create(run: RunRecord, expectedSessionRevision?: string): Promise<RunRecord> {
    return this.serial.run(async () => {
      this.assertRequestAllowed(run.requestKey, run.sessionId);
      const existing = this.catalog(true).find((item) => item.requestKey === run.requestKey);
      if (existing) {
        if (existing.requestHash !== run.requestHash)
          throw new Error('Idempotency key reused with different arguments');
        return this.load(existing.id);
      }
      const sessionRuns = this.catalog(true).filter((item) => item.sessionId === run.sessionId);
      if (run.parentRunId) {
        const latest = latestSessionRun(sessionRuns);
        if (!latest) throw new ResourceNotFoundError('task');
        if (latest.id !== run.parentRunId) throw new SessionChangedError(latest.id);
      }
      assertKnownSessionOutcomes(sessionRuns);
      if (
        expectedSessionRevision !== undefined &&
        expectedSessionRevision !== this.sessionRevision(run.sessionId)
      )
        throw new Error(
          'Состояние беседы изменилось во время подготовки. Повторите отправку сообщения.',
        );
      if (
        sessionRuns.some(
          (item) =>
            !item.deletedAt && ['running', 'awaiting_approval', 'paused'].includes(item.status),
        )
      ) {
        throw new ApplicationError('TASK_BUSY', 'Session already has an active or paused run');
      }
      const created = clone(run);
      await this.persist(created, 'run.created', {});
      return clone(created);
    });
  }
  /** Последовательно применяет изменение к копии и фиксирует его в журнале. */
  mutate(
    runId: string,
    type: string,
    payload: unknown,
    update: (run: RunRecord) => void,
  ): Promise<RunRecord> {
    return this.serial.run(async () => {
      this.assertWritable();
      const next = await this.load(runId);
      update(next);
      await this.persist(next, type, payload);
      return clone(next);
    });
  }
  /** Сериализует служебные файлы с журналом и очисткой, не ожидая долгих инструментов проекта. */
  withStateFiles<T>(work: () => Promise<T>): Promise<T> {
    return this.serial.run(async () => {
      this.assertWritable();
      return work();
    });
  }
  /** Скрывает завершённую задачу; доказательства обучения, учёт расхода и защита от повторов сохраняются. */
  async delete(runId: string): Promise<void> {
    await this.serial.run(async () => {
      this.assertWritable();
      const run = await this.load(runId);
      if (run.deletedAt) return;
      if (!['completed', 'failed', 'cancelled'].includes(run.status))
        throw new ApplicationError('TASK_BUSY', 'Сначала остановите задачу.');
      run.deletedAt = new Date().toISOString();
      await this.persist(run, 'run.deleted', {});
    });
  }
  /** Сначала синхронизирует журнал, затем обновляет память и вспомогательный снимок. */
  private async persist(state: RunRecord, type: string, payload: unknown): Promise<void> {
    validateRunRecord(state);
    const previous = this.indexes.get(state.id);
    const event: JournalEvent = {
      seq: (previous?.count ?? 0) + 1,
      at: new Date().toISOString(),
      type,
      payload,
      state,
    };
    await appendJournal(this.path(state.id), event);
    const offset = previous?.size ?? 0;
    const positions = [...(previous?.positions ?? [])];
    if ((event.seq - 1) % 128 === 0) positions.push({ seq: event.seq, offset });
    const index: JournalIndex = {
      schemaVersion: 1,
      count: event.seq,
      lastOffset: offset,
      size: offset + Buffer.byteLength(JSON.stringify(event) + '\n'),
      mtimeMs: 0,
      ctimeMs: 0,
      positions,
    };
    const entry = catalogEntry(state, event.seq);
    const searchChanged = this.entries.get(state.id)?.searchHash !== entry.searchHash;
    this.remember(state);
    this.entries.set(state.id, entry);
    this.indexes.set(state.id, index);
    this.searches.invalidate();
    // После fsync результата ошибки производных файлов уже не могут отменить подтверждение.
    try {
      const meta = await stat(this.path(state.id));
      index.mtimeMs = meta.mtimeMs;
      index.ctimeMs = meta.ctimeMs;
    } catch {
      /* Перестроим индекс при следующем запуске. */
    }
    if (searchChanged) await this.searches.save(state);
    await saveIndex(this.indexPath(state.id), index, entry);
    await writeSnapshot(join(this.directory, 'runs', state.id + '.json'), state);
  }
  /** Сохраняет полный результат инструмента в отдельном файле текущего запуска. */
  async artifact(runId: string, content: string): Promise<string> {
    this.assertWritable();
    await this.load(runId);
    const artifactId = id();
    const directory = join(this.directory, 'artifacts', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, artifactId + '.txt'), content, { mode: 0o600 });
    return artifactId;
  }
  /** Защита действует и после удаления текста задачи, в том числе после перезапуска сервиса. */
  assertRequestAllowed(requestKey: string, sessionId?: string): void {
    this.assertWritable();
    const requestDigest = hash(requestKey);
    if (
      (sessionId && this.purged.has(sessionId)) ||
      [...this.purged.values()].some((record) => record.requestDigests.includes(requestDigest))
    )
      throw new Error('Эта беседа удалена навсегда. Для новой задачи нужен новый запрос.');
  }
  /** Возвращает неперсистентную диагностику отказа записи до перезапуска сервиса. */
  get recoveryError(): string | undefined {
    return this.recoveryFailure;
  }
  /** Блокирует новые изменения, если даже остановку задачи не удалось сохранить. */
  requireRecovery(error: unknown): void {
    this.recoveryFailure ??=
      'Не удалось сохранить состояние задачи. Проверьте свободное место и доступ к папке состояния, затем закройте Harness и откройте заново. Причина: ' +
      message(error);
  }
  /** Запрещает запись при отказе хранения или подтверждённой очистке данных. */
  assertWritable(): void {
    if (this.recoveryFailure)
      throw new ApplicationError('STORAGE_UNAVAILABLE', this.recoveryFailure);
    if (this.maintenance)
      throw new ApplicationError(
        'TASK_BUSY',
        'Удаляется беседа. Повторите действие после завершения удаления.',
      );
  }
  /** Дожидается прежних изменений и устанавливает блокировку обслуживания после проверки. */
  beginMaintenance(check: () => void): Promise<() => void> {
    return this.serial.run(async () => {
      this.assertWritable();
      check();
      this.maintenance = true;
      return () => {
        this.maintenance = false;
      };
    });
  }
  /** Ищет сохранённое намерение удаления, к которому относится запуск. */
  purgeRecord(runId: string): PurgeRecord | undefined {
    return [...this.purged.values()].find((record) => record.runIds.includes(runId));
  }
  /** Маркер синхронизируется до первого удаления и остаётся для защиты от повторов. */
  recordPurge(record: PurgeRecord): Promise<void> {
    return this.serial.run(async () => {
      await writePurgeRecord(this.directory, record);
      this.purged.set(record.sessionId, clone(record));
    });
  }
  /** Убирает файлы и кэш выбранной беседы после остановки её писателей. */
  purgeFiles(record: PurgeRecord): Promise<void> {
    return this.serial.run(async () => {
      await this.output.forget(record.runIds);
      await removeRunFiles(this.directory, record);
      for (const runId of record.runIds) {
        this.runs.delete(runId);
        this.entries.delete(runId);
        this.indexes.delete(runId);
        this.historical.delete(runId);
        this.pinned.delete(runId);
        this.searches.invalidate();
      }
    });
  }
  /** Читает часть артефакта текущего запуска или предшествующего этапа той же беседы. */
  async readArtifact(
    runId: string,
    artifactId: string,
    offset: number,
    limit: number,
  ): Promise<string> {
    const run = await this.load(runId);
    if (!/^[a-f0-9-]{36}$/.test(artifactId)) throw new Error('Invalid artifact ID');
    let content: string;
    try {
      content = await readFile(
        join(this.directory, 'artifacts', runId, artifactId + '.txt'),
        'utf8',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Продолжения хранят ссылки на прежние результаты; владельца ищем только по метаданным беседы.
      const owner = [...this.entries.values()].find(
        (candidate) =>
          candidate.id !== runId &&
          candidate.sessionId === run.sessionId &&
          candidate.workspace === run.workspace &&
          candidate.artifacts?.some((artifact) => artifact.id === artifactId),
      );
      if (!owner) throw error;
      content = await readFile(
        join(this.directory, 'artifacts', owner.id, artifactId + '.txt'),
        'utf8',
      );
    }
    return content.slice(offset, offset + limit);
  }
}
