import { readdir, open, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { clone, hash, Serial } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import type { IndexRebuildReport } from '../diagnostics/history-types.js';
import { HistoryCache } from '../sessions/cache.js';
import { appendJournal, scanJournal, JournalReadError } from '../sessions/journal.js';
import {
  buildIndex,
  indexedPage,
  saveIndex,
  type JournalIndex,
} from '../sessions/journal-index.js';
import { assertRealDirectory, syncDirectory } from '../sessions/files.js';
import { projectSummarySchema } from './schema.js';
import {
  projectIdentifier,
  validateProject,
  validateProjectEvent,
  type ProjectJournalEvent,
} from './validation.js';
import type { ProjectRecord, ProjectSummary, ProjectEvent } from './types.js';
import {
  readProjectPurgeRecords,
  writeProjectPurgeRecord,
  type ProjectPurgeRecord,
} from './purge-records.js';

/** Списки проектов используют компактный каталог; журнал читается только для выбранного проекта. */
export class ProjectStore {
  private readonly serial = new Serial();
  private readonly entries = new Map<string, ProjectSummary>();
  private readonly indexes = new Map<string, JournalIndex>();
  private readonly cache = new HistoryCache<ProjectRecord>(16 * 1024 * 1024);
  private readonly requests = new Map<string, string>();
  private readonly purged = new Map<string, ProjectPurgeRecord>();
  recoveryError?: string;
  constructor(readonly directory: string) {}

  /** Владелец состояния восстанавливает только оборванный хвост до запуска исполнителей. */
  async initialize(recover = true): Promise<void> {
    try {
      for (const name of [
        'project-records',
        'project-index',
        'project-artifacts',
        'project-purges',
      ])
        await assertRealDirectory(join(this.directory, name));
      for (const record of await readProjectPurgeRecords(this.directory))
        this.purged.set(record.projectId, record);
      const files = await readdir(join(this.directory, 'project-records'), {
        withFileTypes: true,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const file of files) {
        if (!file.name.endsWith('.jsonl')) continue;
        if (!file.isFile()) throw new Error('PROJECT_UNSAFE_SOURCE');
        const id = projectIdentifier.parse(file.name.slice(0, -6));
        if (this.purged.has(id)) continue;
        await this.assertSource(id);
        const validate = (value: unknown, seq: number) => validateProjectEvent(value, seq, id);
        let rebuilt;
        try {
          rebuilt = await buildIndex(this.path(id), validate);
        } catch (error) {
          if (
            !recover ||
            !(error instanceof JournalReadError) ||
            error.code !== 'JOURNAL_TORN_TAIL'
          )
            throw error;
          const handle = await open(this.path(id), 'r+');
          try {
            await handle.truncate(error.offset);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await syncDirectory(join(this.directory, 'project-records'));
          rebuilt = await buildIndex(this.path(id), validate);
        }
        if (!rebuilt.last) continue;
        this.indexes.set(id, rebuilt.index);
        this.remember(rebuilt.last.state);
        await this.saveDerived(rebuilt.last.state, rebuilt.index);
      }
    } catch {
      this.recoveryError = 'Повреждена история проектов. Доступен просмотр; выполнение запрещено.';
    }
  }

  /** Идентификатор запроса сохраняется независимо от повторного открытия интерфейса. */
  findRequest(requestKey: string): string | undefined {
    const digest = hash(requestKey);
    return (
      [...this.purged.values()].find((record) => record.requestDigest === digest)?.projectId ??
      this.requests.get(requestKey)
    );
  }
  /** Повтор старого запроса не может создать заново уже удалённый проект. */
  assertRequestAllowed(requestKey: string): void {
    const digest = hash(requestKey);
    if ([...this.purged.values()].some((record) => record.requestDigest === digest))
      throw new ApplicationError(
        'PROJECT_MANAGED',
        'Этот проект удалён навсегда. Для новой задачи создайте новый проект.',
      );
  }
  /** Каталог не содержит конфигураций, результатов инструментов и переписки. */
  catalog(includeArchived = false): ProjectSummary[] {
    return [...this.entries.values()]
      .filter((item) => includeArchived || !item.archivedAt)
      .sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.projectId.localeCompare(b.projectId),
      )
      .map(clone);
  }
  /** Последняя запись читается по смещению, не загружая весь журнал проекта. */
  async get(projectId: string): Promise<ProjectRecord> {
    const entry = this.entries.get(projectId),
      index = this.indexes.get(projectId);
    if (!entry || !index) throw new ResourceNotFoundError('project');
    const cached = this.cache.get(projectId);
    if (cached) return clone(cached);
    for await (const row of scanJournal(this.path(projectId), index.lastOffset)) {
      const record = validateProjectEvent(row.value, index.count, projectId).state;
      if (this.entries.get(projectId) !== entry) return this.get(projectId);
      this.cache.set(projectId, record);
      return clone(record);
    }
    throw new ApplicationError('STORAGE_UNAVAILABLE', 'Не найдена последняя запись проекта.');
  }
  /** События для живого экрана не включают внутренние снимки и приватную конфигурацию. */
  async events(projectId: string, after: number, limit: number): Promise<ProjectEvent[]> {
    const index = this.indexes.get(projectId);
    if (!index) throw new ResourceNotFoundError('project');
    const rows = await indexedPage(this.path(projectId), index, after, limit, (value, seq) =>
      validateProjectEvent(value, seq, projectId),
    );
    return rows.map(({ seq, at, type, message }) => ({ seq, at, type, message }));
  }
  /** Единственный писатель подтверждает журнал до обновления каталога и производного индекса. */
  save(
    record: ProjectRecord,
    expected: number,
    type: string,
    message: string,
  ): Promise<ProjectRecord> {
    return this.serial.run(async () => {
      if (this.recoveryError) throw new ApplicationError('STORAGE_UNAVAILABLE', this.recoveryError);
      if (this.purged.has(record.id)) throw new ResourceNotFoundError('project');
      const previous = this.entries.get(record.id)?.revision ?? 0;
      if (previous !== expected)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Проект изменён в другом окне. Откройте его заново.',
        );
      const next = clone(record);
      next.revision = expected + 1;
      next.updatedAt = new Date().toISOString();
      validateProject(next);
      const event: ProjectJournalEvent = {
        schemaVersion: 1,
        seq: next.revision,
        at: next.updatedAt,
        type,
        message,
        state: next,
      };
      try {
        await appendJournal(this.path(next.id), event);
      } catch (error) {
        const expectedSize = this.indexes.get(next.id)?.size ?? 0;
        let actualSize: number | undefined;
        try {
          actualSize = (await stat(this.path(next.id))).size;
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') actualSize = 0;
        }
        if (actualSize !== expectedSize) {
          this.recoveryError =
            'Исход записи проекта неизвестен. Перезапустите сервис для проверки журнала.';
          throw new ApplicationError('STORAGE_UNAVAILABLE', this.recoveryError, { cause: error });
        }
        throw error;
      }
      // Индекс можно пересоздать; подтверждённое событие уже нельзя объявить неуспешным.
      const previousIndex = this.indexes.get(next.id);
      const offset = previousIndex?.size ?? 0;
      const positions = [...(previousIndex?.positions ?? [])];
      if ((next.revision - 1) % 128 === 0) positions.push({ seq: next.revision, offset });
      const index: JournalIndex = {
        schemaVersion: 1,
        count: next.revision,
        lastOffset: offset,
        size: offset + Buffer.byteLength(JSON.stringify(event) + '\n'),
        mtimeMs: 0,
        ctimeMs: 0,
        positions,
      };
      this.indexes.set(next.id, index);
      this.remember(next);
      try {
        const meta = await stat(this.path(next.id));
        index.mtimeMs = meta.mtimeMs;
        index.ctimeMs = meta.ctimeMs;
      } catch {
        /* Отказ производных данных не отменяет подтверждённое событие. */
      }
      await this.saveDerived(next, index);
      return clone(next);
    });
  }
  /** Перестраивает только производные индексы под очередью владельца, не ремонтируя источники. */
  rebuildIndex(): Promise<IndexRebuildReport> {
    return this.serial.run(async () => {
      const report: IndexRebuildReport = {
        checkedAt: new Date().toISOString(),
        rebuilt: 0,
        skipped: 0,
        issues: [],
      };
      try {
        await assertRealDirectory(join(this.directory, 'project-records'));
        await assertRealDirectory(join(this.directory, 'project-index'));
      } catch {
        return {
          ...report,
          skipped: 1,
          issues: [{ code: 'STORAGE_UNSAFE_PATH', kind: 'project' }],
        };
      }
      const names = await readdir(join(this.directory, 'project-records')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -6);
        if (this.purged.has(id)) continue;
        try {
          await this.assertSource(id);
          const { index, last } = await buildIndex(this.path(id), (value, seq) =>
            validateProjectEvent(value, seq, id),
          );
          if (!last) throw new Error('PROJECT_EMPTY_JOURNAL');
          await saveIndex(
            join(this.directory, 'project-index', id + '.json'),
            index,
            projectSummary(last.state),
            true,
          );
          this.indexes.set(id, index);
          report.rebuilt++;
        } catch {
          report.skipped++;
          report.issues.push({ code: 'INDEX_REBUILD_FAILED', kind: 'project' });
        }
      }
      return report;
    });
  }
  /** Убирает удалённые записи из кэша после завершения прикладного каскада. */
  forget(projectId: string): void {
    this.entries.delete(projectId);
    this.indexes.delete(projectId);
    this.cache.delete(projectId);
    for (const [key, id] of this.requests) if (id === projectId) this.requests.delete(key);
  }
  /** Маркер становится источником истины до удаления журналов и очищает производные кэши. */
  recordPurge(record: ProjectPurgeRecord): Promise<void> {
    return this.serial.run(async () => {
      await writeProjectPurgeRecord(this.directory, record);
      this.purged.set(record.projectId, clone(record));
      this.forget(record.projectId);
    });
  }
  /** Внутренний журнал не может быть ссылкой на внешний пользовательский файл. */
  private async assertSource(projectId: string): Promise<void> {
    await assertRealDirectory(join(this.directory, 'project-records'));
    const info = await lstat(this.path(projectId));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('PROJECT_UNSAFE_SOURCE');
  }
  private path(projectId: string): string {
    return join(this.directory, 'project-records', projectIdentifier.parse(projectId) + '.jsonl');
  }
  private remember(record: ProjectRecord): void {
    const previous = this.requests.get(record.requestKey);
    if (previous && previous !== record.id) throw new Error('PROJECT_DUPLICATE_REQUEST');
    this.requests.set(record.requestKey, record.id);
    this.entries.set(record.id, projectSummary(record));
    this.cache.set(record.id, clone(record));
  }
  private async saveDerived(record: ProjectRecord, index: JournalIndex): Promise<void> {
    try {
      await saveIndex(
        join(this.directory, 'project-index', record.id + '.json'),
        index,
        projectSummary(record),
      );
    } catch {
      /* Производные данные будут пересозданы из подтверждённого журнала. */
    }
  }
}

/** Сводка не растёт вместе с журналом и пригодна для счётчиков главного меню. */
export function projectSummary(record: ProjectRecord): ProjectSummary {
  const stages = Object.values(record.stages);
  return projectSummarySchema.parse({
    projectId: record.id,
    title: record.title,
    goal: record.goal.slice(0, 1000),
    workspace: record.workspace,
    profile: record.profile,
    revision: record.revision,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
    progress: {
      total: record.plan?.stages.length ?? 0,
      completed: stages.filter((s) => s.status === 'completed').length,
      running: stages.filter((s) => ['running', 'checking'].includes(s.status)).length,
      blocked: stages.filter((s) => ['blocked', 'manual'].includes(s.status)).length,
    },
  });
}
