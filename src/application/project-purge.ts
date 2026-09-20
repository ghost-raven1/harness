import { ApplicationError } from '../shared/application-error.js';
import { hash } from '../shared/primitives.js';
import type { ProjectRecord } from '../projects/types.js';
import type { ProjectStore } from '../projects/store.js';
import {
  readProjectPurgeRecords,
  writeProjectPurgeRecord,
  removeProjectFiles,
  projectDraftFiles,
  type ProjectPurgeRecord,
} from '../projects/purge-records.js';
import type { SessionStore } from '../sessions/ports.js';
import {
  linkedPurgeDirectories,
  removeRunFiles,
  writePurgeRecord,
  type PurgeRecord,
} from '../sessions/purge-records.js';
import type { LearningService } from '../learning/service.js';
import { FileLearningStore } from '../learning/store.js';
import { learningPurgePlan } from '../learning/purge.js';
import type { HarnessRuntime } from '../runtime/engine.js';
import type { ToolScheduler } from '../tools/scheduler.js';
import { taskStorageInventory } from './data-reset-records.js';

interface ProjectPurgeOptions {
  projects: ProjectStore;
  sessions: SessionStore;
  learning: LearningService;
  learningStore: FileLearningStore;
  runtime: HarnessRuntime;
  scheduler: ToolScheduler;
  busy(): boolean;
  onPurged?(projectId: string): void;
  forgetMeasurements?(runIds: string[]): Promise<void>;
  serialize<T>(work: () => Promise<T>): Promise<T>;
}

/** Удаляет проект единым каскадом; вызывающая сторона уже удерживает очередь проектов. */
export class ProjectPurge {
  constructor(private readonly options: ProjectPurgeOptions) {}

  /** Общий сброс берёт очередь проектов раньше диспетчера и очереди сессий. */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    return this.options.serialize(work);
  }
  /** Активный проект может находиться между этапами без запущенной задачи runtime. */
  busy(): boolean {
    return this.options.busy();
  }

  /** Повреждение проектного журнала запрещает очистку по неполному каталогу. */
  get recoveryError(): string | undefined {
    return this.options.projects.recoveryError;
  }

  /** Незавершённый каскад запрещает изменение проектов до восстановления владельцем состояния. */
  requireRecovery(): void {
    this.options.projects.recoveryError =
      'Очистка проектов прервана. Перезапустите локальный сервис.';
  }

  /** Квитанция доступна даже после удаления журнала и защищает повторный запрос клиента. */
  async receipt(projectId: string, previewToken: string) {
    const record = (await readProjectPurgeRecords(this.options.projects.directory)).find(
      (item) => item.projectId === projectId,
    );
    if (!record || record.previewToken !== previewToken) return undefined;
    if (!record.complete)
      throw new ApplicationError(
        'STORAGE_UNAVAILABLE',
        'Удаление проекта прервано. Перезапустите локальный сервис для завершения очистки.',
      );
    return result(record);
  }

  /** Состав включает все связанные беседы, артефакты, индексы и черновики проекта. */
  async preview(projectId: string) {
    const project = await this.options.projects.get(projectId);
    const linked = await linkedPurgeDirectories(this.options.sessions.directory);
    const plan = await this.plan(project, !linked.length);
    const blockers: string[] = [];
    if (this.options.projects.recoveryError) blockers.push(this.options.projects.recoveryError);
    if (this.options.sessions.recoveryError) blockers.push(this.options.sessions.recoveryError);
    if (
      this.busy() ||
      this.options.runtime.busy() ||
      this.options.sessions
        .catalog(true)
        .some((run) => ['running', 'awaiting_approval'].includes(run.status))
    )
      blockers.push('Сначала остановите работающие проекты и задачи.');
    if (this.options.learning.busy())
      blockers.push('Сейчас проверяется урок. Дождитесь окончания проверки.');
    if (plan.runs.some((run) => run.unknownOutcome))
      blockers.push(
        'В проекте есть операция с неизвестным результатом. Сначала проверьте её результат.',
      );
    if (linked.length)
      blockers.push('Внутренние папки Harness заменены ссылками. Исправьте пути перед удалением.');
    if (
      this.options.sessions
        .catalog(true)
        .some(
          (run) =>
            !plan.runs.some((selected) => selected.id === run.id) &&
            run.status === 'paused' &&
            plan.selection.affectedVersions.includes(run.learningVersion),
        )
    )
      blockers.push('Другая задача на паузе использует знания этого проекта.');
    for (const item of this.options.projects.catalog(true)) {
      if (item.projectId === project.id || ['completed', 'cancelled'].includes(item.status))
        continue;
      if (
        plan.selection.affectedVersions.includes(
          (await this.options.projects.get(item.projectId)).learningVersion,
        )
      )
        blockers.push('Другой незавершённый проект использует эти знания.');
    }
    return {
      projectId,
      previewToken: hash({ project, ...plan }),
      available: !blockers.length,
      blockers,
      runs: plan.runs.length,
      sessions: new Set(plan.runs.map((run) => run.sessionId)).size,
      artifacts: plan.inventory.filter(
        (file) =>
          file.path.startsWith('artifacts/') ||
          file.path.startsWith('project-artifacts/') ||
          file.path.startsWith('project-content/'),
      ).length,
    };
  }

  /** Маркер намерения записывается раньше первого удаления; авария оставляет безопасное восстановление. */
  async purge(project: ProjectRecord, previewToken: string) {
    const previous = await this.receipt(project.id, previewToken);
    if (previous) return previous;
    return this.options.scheduler.schedule('write', async () => {
      const unlockSessions = await this.options.sessions.beginMaintenance(() => this.assertIdle());
      let unlockLearning: (() => void) | undefined, unlockStore: (() => void) | undefined;
      let started = false,
        completed = false;
      try {
        unlockLearning = this.options.learning.beginMaintenance();
        unlockStore = await this.options.learningStore.beginMaintenance();
        const preview = await this.preview(project.id);
        if (!preview.available) {
          const unsafe =
            !!this.options.projects.recoveryError ||
            !!this.options.sessions.recoveryError ||
            (await linkedPurgeDirectories(this.options.sessions.directory)).length > 0;
          const unknown = this.options.sessions
            .catalog(true)
            .some((run) => run.project?.projectId === project.id && run.unknownOutcome);
          throw new ApplicationError(
            unsafe ? 'STORAGE_UNAVAILABLE' : unknown ? 'UNKNOWN_OUTCOME' : 'PROJECT_CONFLICT',
            preview.blockers.join('\n'),
          );
        }
        if (preview.previewToken !== previewToken)
          throw new ApplicationError(
            'STALE_PREVIEW',
            'Состав проекта изменился. Повторите предпросмотр удаления.',
          );
        const plan = await this.plan(project);
        const record = this.record(
          project,
          previewToken,
          plan.runs,
          plan.draftFiles,
          plan.selection,
        );
        started = true;
        await this.options.projects.recordPurge(record);
        this.options.onPurged?.(project.id);
        for (const session of record.sessions) await this.options.sessions.recordPurge(session);
        for (const session of record.sessions) {
          await this.options.learningStore.purge(session);
          await this.options.forgetMeasurements?.(session.runIds);
          await this.options.sessions.purgeFiles(session);
          await this.options.sessions.recordPurge({ ...session, complete: true });
        }
        await removeProjectFiles(this.options.projects.directory, record);
        await this.options.projects.recordPurge({ ...record, complete: true });
        completed = true;
        return result(record);
      } catch (error) {
        if (started) {
          this.options.projects.recoveryError =
            'Удаление проекта прервано. Перезапустите локальный сервис.';
          throw new ApplicationError('STORAGE_UNAVAILABLE', this.options.projects.recoveryError, {
            cause: error,
          });
        }
        throw error;
      } finally {
        if (!started || completed) {
          unlockStore?.();
          unlockLearning?.();
          unlockSessions();
        }
      }
    });
  }

  /** Общий сброс сохраняет знания отдельно, поэтому проектные маркеры не удаляют их повторно. */
  async resetRecords(previewToken = '0'.repeat(64)): Promise<ProjectPurgeRecord[]> {
    const records: ProjectPurgeRecord[] = [];
    for (const summary of this.options.projects.catalog(true)) {
      const project = await this.options.projects.get(summary.projectId),
        plan = await this.plan(project);
      records.push({
        ...this.record(project, previewToken, plan.runs, plan.draftFiles, {
          candidateIds: [],
          evidenceIds: [],
          reportIds: [],
        }),
        preserveLearning: true,
      });
    }
    return records;
  }

  /** Черновики и каталоги проектов участвуют в том же подтверждённом сбросе, что и задачи. */
  async resetProjects(records: ProjectPurgeRecord[], complete: boolean): Promise<void> {
    for (const record of records) {
      if (complete) await removeProjectFiles(this.options.projects.directory, record);
      await this.options.projects.recordPurge({ ...record, complete });
      this.options.onPurged?.(record.projectId);
    }
  }

  /** Знания нельзя очищать, пока незавершённый проект закрепляет соответствующий выпуск. */
  async usesLearning(versions?: string[]): Promise<boolean> {
    for (const item of this.options.projects.catalog(true)) {
      if (['completed', 'cancelled'].includes(item.status)) continue;
      const version = (await this.options.projects.get(item.projectId)).learningVersion;
      if (versions ? versions.includes(version) : version !== 'baseline') return true;
    }
    return false;
  }

  private assertIdle(): void {
    if (
      this.busy() ||
      this.options.runtime.busy() ||
      this.options.sessions
        .catalog(true)
        .some((run) => ['running', 'awaiting_approval'].includes(run.status))
    )
      throw new ApplicationError('TASK_BUSY', 'Сначала остановите работающие проекты и задачи.');
  }

  private async plan(project: ProjectRecord, inspectFiles = true) {
    const all = this.options.sessions.catalog(true);
    const ids = new Set(project.runIds);
    const sessionIds = new Set(
      all
        .filter((run) => ids.has(run.id) || run.project?.projectId === project.id)
        .map((run) => run.sessionId),
    );
    const runs = all.filter((run) => sessionIds.has(run.sessionId));
    if (runs.some((run) => run.project && run.project.projectId !== project.id))
      throw new ApplicationError(
        'PROJECT_CONFLICT',
        'Беседа относится к нескольким проектам. Удаление остановлено.',
      );
    const state = this.options.learningStore.read(),
      selection = learningPurgePlan(
        state,
        runs.map((run) => run.id),
      );
    const draftFiles = inspectFiles
      ? await projectDraftFiles(
          this.options.projects.directory,
          project.id,
          hash(project.requestKey),
        )
      : [];
    const inventory = (
      inspectFiles ? await taskStorageInventory(this.options.sessions.directory) : []
    ).filter(
      (file) =>
        file.path.startsWith('project-records/' + project.id + '.') ||
        file.path.startsWith('project-index/' + project.id + '.') ||
        file.path === 'exports/projects/' + project.id ||
        file.path.startsWith('exports/projects/' + project.id + '/') ||
        file.path === 'project-content/' + project.id ||
        file.path.startsWith('project-content/' + project.id + '/') ||
        file.path === 'project-artifacts/' + project.id ||
        file.path.startsWith('project-artifacts/' + project.id + '/') ||
        (file.path.startsWith('drafts/') &&
          (draftFiles.includes(file.path.slice(7)) ||
            [...sessionIds].some((id) => file.path.startsWith('drafts/' + id + '.')))) ||
        runs.some(
          (run) =>
            ['runs', 'output', 'search', 'indexes/runs', 'indexes/output'].some((folder) =>
              file.path.startsWith(folder + '/' + run.id + '.'),
            ) ||
            ['artifacts', 'file-backups'].some(
              (folder) =>
                file.path === folder + '/' + run.id ||
                file.path.startsWith(folder + '/' + run.id + '/'),
            ),
        ),
    );
    return { runs, state, selection, draftFiles, inventory };
  }

  private record(
    project: ProjectRecord,
    previewToken: string,
    runs: ReturnType<SessionStore['catalog']>,
    draftFiles: string[],
    selection: Pick<PurgeRecord, 'candidateIds' | 'evidenceIds' | 'reportIds'>,
  ): ProjectPurgeRecord {
    return {
      schemaVersion: 1,
      projectId: project.id,
      revision: project.revision,
      requestDigest: hash(project.requestKey),
      previewToken,
      complete: false,
      preserveLearning: false,
      draftFiles,
      sessions: [...new Set(runs.map((run) => run.sessionId))].map((sessionId) => {
        const entries = runs.filter((run) => run.sessionId === sessionId);
        return {
          schemaVersion: 1,
          sessionId,
          runIds: entries.map((run) => run.id),
          requestDigests: entries.map((run) => hash(run.requestKey)),
          candidateIds: selection.candidateIds,
          evidenceIds: selection.evidenceIds,
          reportIds: selection.reportIds,
          previewToken,
          complete: false,
        };
      }),
    };
  }
}

/** Завершает проектный каскад до чтения журналов и запуска фоновой работы. */
export async function recoverProjectPurges(directory: string): Promise<void> {
  const records = (await readProjectPurgeRecords(directory)).filter((record) => !record.complete);
  if (!records.length) return;
  const learning = new FileLearningStore(directory);
  await learning.initialize();
  if (learning.recoveryError)
    throw new ApplicationError('STORAGE_UNAVAILABLE', learning.recoveryError);
  for (const record of records) {
    // Сброс задач сохраняет знания; незавершённый проектный маркер сам продолжит очистку файлов.
    for (const session of record.sessions)
      await writePurgeRecord(directory, { ...session, complete: record.preserveLearning });
    for (const session of record.sessions) {
      if (!record.preserveLearning) await learning.purge(session);
      await removeRunFiles(directory, session);
      await writePurgeRecord(directory, { ...session, complete: true });
    }
    await removeProjectFiles(directory, record);
    await writeProjectPurgeRecord(directory, { ...record, complete: true });
  }
}

/** Возвращает одинаковую квитанцию до и после перезапуска. */
function result(record: ProjectPurgeRecord): { purged: true; projectId: string; runs: number } {
  return {
    purged: true,
    projectId: record.projectId,
    runs: record.sessions.reduce((count, session) => count + session.runIds.length, 0),
  };
}
