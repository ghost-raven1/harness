import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clone, hash, id, Serial } from '../shared/primitives.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import { SessionChangedError } from '../shared/session-conflict.js';
import { writeSnapshot } from './files.js';
import { appendJournal, readJournal } from './journal.js';
import type { RunRecord, JournalEvent, SessionStore } from './types.js';
import { RunOutputStore } from './output.js';
import {
  readPurgeRecords,
  removeRunFiles,
  writePurgeRecord,
  type PurgeRecord,
} from './purge-records.js';

/** Хранилище с одним писателем; синхронизированный журнал важнее снимков. */
export class FileSessionStore implements SessionStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, JournalEvent[]>();
  private readonly serial = new Serial();
  private readonly purged = new Map<string, PurgeRecord>();
  private maintenance = false;
  readonly output: RunOutputStore;
  constructor(readonly directory: string) {
    this.output = new RunOutputStore(directory);
  }
  async initialize(): Promise<void> {
    for (const record of await readPurgeRecords(this.directory))
      this.purged.set(record.sessionId, record);
    await mkdir(join(this.directory, 'runs'), { recursive: true, mode: 0o700 });
    for (const name of await readdir(join(this.directory, 'runs'))) {
      if (!name.endsWith('.jsonl')) continue;
      if ([...this.purged.values()].some((record) => record.runIds.includes(name.slice(0, -6))))
        continue;
      const path = join(this.directory, 'runs', name);
      const rows = await readJournal<JournalEvent>(path);
      rows.forEach((event, index) => {
        if (event.seq !== index + 1 || event.state?.schemaVersion !== 1 || !event.state.id) {
          throw new Error('Unsupported or corrupt session journal: ' + name);
        }
      });
      const last = rows.at(-1);
      if (!last) continue;
      this.runs.set(last.state.id, last.state);
      this.events.set(last.state.id, rows);
    }
    for (const run of this.list(true)) await this.recoverInterrupted(run.id);
  }
  /** Вызывается после остановки исполнителей; статус паузы сам по себе не доказывает завершение записи. */
  async recoverInterrupted(runId: string): Promise<void> {
    const run = this.get(runId);
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
  list(includeDeleted = false): RunRecord[] {
    return [...this.runs.values()]
      .filter((run) => includeDeleted || !run.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }
  get(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new ResourceNotFoundError('task');
    return clone(run);
  }
  history(runId: string, after: number, limit?: number): JournalEvent[] {
    return (this.events.get(runId) ?? [])
      .slice(after, limit === undefined ? undefined : after + limit)
      .map(clone);
  }
  create(run: RunRecord): Promise<RunRecord> {
    return this.serial.run(async () => {
      this.assertRequestAllowed(run.requestKey, run.sessionId);
      const existing = this.list(true).find((item) => item.requestKey === run.requestKey);
      if (existing) {
        if (existing.requestHash !== run.requestHash)
          throw new Error('Idempotency key reused with different arguments');
        return existing;
      }
      if (run.parentRunId) {
        const latest = this.list()
          .filter((item) => item.sessionId === run.sessionId)
          .at(-1);
        if (!latest) throw new ResourceNotFoundError('task');
        if (latest.id !== run.parentRunId) throw new SessionChangedError(latest.id);
      }
      if (
        this.list().some(
          (item) =>
            item.sessionId === run.sessionId &&
            ['running', 'awaiting_approval', 'paused'].includes(item.status),
        )
      ) {
        throw new Error('Session already has an active or paused run');
      }
      await this.persist(clone(run), 'run.created', {});
      return this.get(run.id);
    });
  }
  mutate(
    runId: string,
    type: string,
    payload: unknown,
    update: (run: RunRecord) => void,
  ): Promise<RunRecord> {
    return this.serial.run(async () => {
      this.assertWritable();
      const next = this.get(runId);
      update(next);
      await this.persist(next, type, payload);
      return this.get(runId);
    });
  }
  /** Скрывает завершённую задачу; доказательства обучения, учёт расхода и защита от повторов сохраняются. */
  async delete(runId: string): Promise<void> {
    await this.serial.run(async () => {
      this.assertWritable();
      const run = this.get(runId);
      if (run.deletedAt) return;
      if (!['completed', 'failed', 'cancelled'].includes(run.status))
        throw new Error('Сначала остановите задачу.');
      run.deletedAt = new Date().toISOString();
      await this.persist(run, 'run.deleted', {});
    });
  }
  private async persist(state: RunRecord, type: string, payload: unknown): Promise<void> {
    const previous = this.events.get(state.id) ?? [];
    const event: JournalEvent = {
      seq: previous.length + 1,
      at: new Date().toISOString(),
      type,
      payload,
      state,
    };
    await appendJournal(join(this.directory, 'runs', state.id + '.jsonl'), event);
    this.runs.set(state.id, state);
    this.events.set(state.id, [...previous, event]);
    await writeSnapshot(join(this.directory, 'runs', state.id + '.json'), state);
  }
  async artifact(runId: string, content: string): Promise<string> {
    this.assertWritable();
    this.get(runId);
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
  assertWritable(): void {
    if (this.maintenance)
      throw new Error('Удаляется беседа. Повторите действие после завершения удаления.');
  }
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
  purgeFiles(record: PurgeRecord): Promise<void> {
    return this.serial.run(async () => {
      await this.output.forget(record.runIds);
      await removeRunFiles(this.directory, record);
      for (const runId of record.runIds) {
        this.runs.delete(runId);
        this.events.delete(runId);
      }
    });
  }
  async readArtifact(
    runId: string,
    artifactId: string,
    offset: number,
    limit: number,
  ): Promise<string> {
    const run = this.get(runId);
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
      const owner = [...this.runs.values()].find(
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
