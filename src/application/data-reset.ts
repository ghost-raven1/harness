import { ApplicationError } from '../shared/application-error.js';
import type { SessionStore } from '../sessions/ports.js';
import type { LearningService } from '../learning/service.js';
import { FileLearningStore } from '../learning/store.js';
import type { HarnessRuntime } from '../runtime/engine.js';
import type { ToolScheduler } from '../tools/scheduler.js';
import {
  linkedPurgeDirectories,
  removeRunFiles,
  writePurgeRecord,
} from '../sessions/purge-records.js';
import { hash } from '../shared/primitives.js';
import type { ProjectPurge } from './project-purge.js';
import { removeProjectFiles, writeProjectPurgeRecord } from '../projects/purge-records.js';
import {
  dataResetScopeSchema,
  type DataResetScope,
  type DataResetRecord,
  lessonExportIds,
  pendingResetRecords,
  readResetRecord,
  removeLessonExports,
  resetSessionRecord,
  writeResetRecord,
  taskStorageInventory,
  removeTaskStorage,
} from './data-reset-records.js';

export { dataResetScopeSchema, type DataResetScope } from './data-reset-records.js';
export interface DataResetPreview {
  scope: DataResetScope;
  tasks: number;
  projects: number;
  sessions: number;
  lessons: number;
  evidence: number;
  jobs: number;
  artifacts: number;
  backups: number;
  exports: number;
  available: boolean;
  blockers: string[];
  previewToken: string;
}

/** Координирует выбранную человеком очистку задач и знаний, сохраняя настройки и учёт расхода. */
export class DataReset {
  constructor(
    private readonly sessions: SessionStore,
    private readonly learning: LearningService,
    private readonly learningStore: FileLearningStore,
    private readonly runtime: HarnessRuntime,
    private readonly scheduler: ToolScheduler,
    private readonly projects?: ProjectPurge,
    private readonly forgetMeasurements?: (runIds: string[]) => Promise<void>,
  ) {}

  /** Собирает выбранный состав очистки, блокирующие операции и токен подтверждения. */
  async preview(input: DataResetScope): Promise<DataResetPreview> {
    const scope = dataResetScopeSchema.parse(input);
    const runs = this.sessions.catalog(true),
      state = this.learningStore.read();
    const removeTasks = scope !== 'learning',
      forgetKnowledge = scope !== 'tasks';
    const runIds = new Set(runs.map((run) => run.id));
    const blockers: string[] = [];
    if (this.sessions.recoveryError) blockers.push(this.sessions.recoveryError);
    if (this.projects?.recoveryError) blockers.push(this.projects.recoveryError);
    if (
      this.projects?.busy() ||
      this.runtime.busy() ||
      runs.some((run) => ['running', 'awaiting_approval'].includes(run.status))
    )
      blockers.push('Сначала остановите работающие задачи и дождитесь их остановки.');
    if (this.learning.busy())
      blockers.push('Сейчас проверяется урок. Дождитесь окончания проверки.');
    if (removeTasks && runs.some((run) => run.unknownOutcome))
      blockers.push(
        'В задачах есть операция с неизвестным результатом. Сначала проверьте её результат.',
      );
    if (
      !removeTasks &&
      runs.some((run) => run.status === 'paused' && run.learningVersion !== 'baseline')
    )
      blockers.push(
        'Задача на паузе использует накопленный опыт. Сначала продолжите или остановите её.',
      );
    if (!removeTasks && (await this.projects?.usesLearning()))
      blockers.push(
        'Незавершённый проект использует накопленный опыт. Сначала завершите или отмените проект.',
      );
    const linked = await linkedPurgeDirectories(this.sessions.directory);
    if (linked.length)
      blockers.push(
        'Внутренние папки Harness заменены ссылками: ' +
          linked.join(', ') +
          '. Исправьте пути перед очисткой.',
      );
    const inventory =
      removeTasks && !linked.length ? await taskStorageInventory(this.sessions.directory) : [];
    const projects =
      removeTasks && !linked.length ? ((await this.projects?.resetRecords()) ?? []) : [];
    const artifacts = inventory.filter((file) => file.path.startsWith('artifacts/')).length;
    const backups = inventory.filter((file) => file.path.startsWith('file-backups/')).length;
    const exports =
      forgetKnowledge && !linked.includes('exports')
        ? await lessonExportIds(this.sessions.directory)
        : [];
    const counts = {
      tasks: removeTasks ? runs.length : 0,
      projects: projects.length,
      sessions: removeTasks ? new Set(runs.map((run) => run.sessionId)).size : 0,
      lessons: forgetKnowledge ? Object.keys(state.candidates).length : 0,
      evidence: forgetKnowledge ? Object.keys(state.evidence).length : 0,
      jobs: state.jobs.filter((job) => forgetKnowledge || runIds.has(job.runId)).length,
      artifacts,
      backups,
      exports:
        exports.length +
        inventory.filter(
          (file) =>
            file.path.startsWith('exports/projects/') && /\.(?:md|report\.json)$/.test(file.path),
        ).length,
    };
    return {
      scope,
      ...counts,
      available: !blockers.length,
      blockers,
      previewToken: hash({ scope, runs, state, counts, exports, inventory, projects }),
    };
  }

  /** Выполняет только подтверждённый состав; повтор того же запроса возвращает прежний успех. */
  async reset(input: DataResetScope, previewToken: string) {
    const scope = dataResetScopeSchema.parse(input);
    const perform = () =>
      this.scheduler.schedule('write', async () => {
        const previous = await readResetRecord(this.sessions.directory, previewToken);
        if (previous?.complete && previous.scope === scope) return resetResult(previous);
        const unlockSessions = await this.sessions.beginMaintenance(() => {
          if (
            this.projects?.busy() ||
            this.runtime.busy() ||
            this.sessions
              .catalog(true)
              .some((run) => ['running', 'awaiting_approval'].includes(run.status))
          )
            throw new ApplicationError(
              'TASK_BUSY',
              'Сначала остановите работающие задачи и дождитесь их остановки.',
            );
        });
        let unlockLearning: (() => void) | undefined, unlockStore: (() => void) | undefined;
        let started = false,
          completed = false;
        try {
          unlockLearning = this.learning.beginMaintenance();
          unlockStore = await this.learningStore.beginMaintenance();
          const preview = await this.preview(scope);
          if (!preview.available) {
            const unsafe = (await linkedPurgeDirectories(this.sessions.directory)).length > 0;
            const unknown = (scope === 'learning' ? [] : this.sessions.catalog(true)).some(
              (run) => run.unknownOutcome,
            );
            throw new ApplicationError(
              unsafe || this.sessions.recoveryError || this.projects?.recoveryError
                ? 'STORAGE_UNAVAILABLE'
                : unknown
                  ? 'UNKNOWN_OUTCOME'
                  : 'TASK_BUSY',
              preview.blockers.join('\n'),
            );
          }
          if (preview.previewToken !== previewToken)
            throw new ApplicationError(
              'STALE_PREVIEW',
              'Состав данных изменился. Откройте предпросмотр очистки заново.',
            );
          const runs = this.sessions.catalog(true);
          const sessionIds =
            scope === 'learning' ? [] : [...new Set(runs.map((run) => run.sessionId))];
          const record: DataResetRecord = {
            schemaVersion: 1,
            scope,
            previewToken,
            complete: false,
            sessions: sessionIds.map((sessionId) => {
              const entries = runs.filter((run) => run.sessionId === sessionId);
              return {
                sessionId,
                runIds: entries.map((run) => run.id),
                requestDigests: entries.map((run) => hash(run.requestKey)),
              };
            }),
            projects:
              scope === 'learning' ? [] : ((await this.projects?.resetRecords(previewToken)) ?? []),
            learningRunIds: runs.map((run) => run.id),
            exportIds: scope === 'tasks' ? [] : await lessonExportIds(this.sessions.directory),
          };
          started = true;
          await writeResetRecord(this.sessions.directory, record);
          await this.projects?.resetProjects(record.projects ?? [], false);
          for (const item of record.sessions)
            await this.sessions.recordPurge(resetSessionRecord(record, item));
          await this.learningStore.reset({
            forgetKnowledge: scope !== 'tasks',
            runIds: record.learningRunIds,
          });
          await this.forgetMeasurements?.(record.sessions.flatMap((item) => item.runIds));
          for (const item of record.sessions)
            await this.sessions.purgeFiles(resetSessionRecord(record, item));
          if (scope !== 'learning') await removeTaskStorage(this.sessions.directory);
          if (scope !== 'tasks')
            await removeLessonExports(this.sessions.directory, record.exportIds);
          await this.projects?.resetProjects(record.projects ?? [], true);
          await writeResetRecord(this.sessions.directory, { ...record, complete: true });
          completed = true;
          return resetResult(record);
        } catch (error) {
          if (started) {
            this.projects?.requireRecovery();
            throw new ApplicationError(
              'STORAGE_UNAVAILABLE',
              'Очистка данных прервалась. Перезапустите локальный сервис: она продолжится автоматически.',
              { cause: error },
            );
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
    return this.projects ? this.projects.serialize(perform) : perform();
  }
}

/** Завершает подтверждённый сброс до загрузки задач и восстановления очереди обучения. */
export async function recoverDataResets(directory: string): Promise<void> {
  const pending = await pendingResetRecords(directory);
  if (!pending.length) return;
  const learning = new FileLearningStore(directory);
  await learning.initialize();
  if (learning.recoveryError)
    throw new ApplicationError('STORAGE_UNAVAILABLE', learning.recoveryError);
  for (const record of pending) {
    for (const project of record.projects ?? []) await writeProjectPurgeRecord(directory, project);
    for (const item of record.sessions)
      await writePurgeRecord(directory, resetSessionRecord(record, item));
    await learning.reset({
      forgetKnowledge: record.scope !== 'tasks',
      runIds: record.learningRunIds,
    });
    for (const item of record.sessions)
      await removeRunFiles(directory, resetSessionRecord(record, item));
    if (record.scope !== 'learning') await removeTaskStorage(directory);
    if (record.scope !== 'tasks') await removeLessonExports(directory, record.exportIds);
    for (const project of record.projects ?? []) {
      await removeProjectFiles(directory, project);
      await writeProjectPurgeRecord(directory, { ...project, complete: true });
    }
    await writeResetRecord(directory, { ...record, complete: true });
  }
}

/** Возвращает одинаковую квитанцию первичного и повторного подтверждения сброса. */
function resetResult(record: DataResetRecord) {
  return {
    reset: true,
    scope: record.scope,
    tasks: record.sessions.reduce((count, session) => count + session.runIds.length, 0),
    sessions: record.sessions.length,
  };
}
