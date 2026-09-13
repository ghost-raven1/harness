import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSessionStore } from './store.js';
import { requiresOutcomeReview } from './invocations.js';
import type { HarnessRuntime } from '../runtime/engine.js';
import type { LearningService } from '../learning/service.js';
import { FileLearningStore } from '../learning/store.js';
import { learningPurgePlan } from '../learning/purge.js';
import type { ToolScheduler } from '../tools/scheduler.js';
import { hash } from '../shared/primitives.js';
import {
  readPurgeRecords,
  removeRunFiles,
  writePurgeRecord,
  linkedPurgeDirectories,
  type PurgeRecord,
} from './purge-records.js';

export interface PurgePreview {
  sessionId: string;
  runIds: string[];
  runs: number;
  artifacts: number;
  backups: number;
  lessons: number;
  evidence: number;
  exports: number;
  available: boolean;
  blockers: string[];
  previewToken: string;
}

/** Удаляет всю беседу: её продолжения содержат копии прежних сообщений. */
export class SessionPurge {
  constructor(
    private readonly sessions: FileSessionStore,
    private readonly learning: LearningService,
    private readonly learningStore: FileLearningStore,
    private readonly runtime: HarnessRuntime,
    private readonly scheduler: ToolScheduler,
  ) {}

  async preview(runId: string): Promise<PurgePreview> {
    const { runs, state, selection } = this.plan(runId);
    const runIds = runs.map((run) => run.id);
    const all = this.sessions.list(true);
    const blockers: string[] = [];
    const linked = await linkedPurgeDirectories(this.sessions.directory);
    if (linked.length)
      blockers.push(
        'Внутренние папки Harness заменены ссылками: ' +
          linked.join(', ') +
          '. Исправьте пути перед удалением.',
      );
    if (
      this.runtime.busy() ||
      all.some((run) => ['running', 'awaiting_approval'].includes(run.status))
    )
      blockers.push('Сначала остановите работающие задачи и дождитесь их остановки.');
    if (this.learning.busy())
      blockers.push('Сейчас проверяется урок. Дождитесь окончания проверки.');
    if (
      runs.some(
        (run) =>
          Object.values(run.invocations).some(requiresOutcomeReview) ||
          run.fileChanges?.some((item) => item.status === 'restoring'),
      )
    )
      blockers.push(
        'В беседе есть операция с неизвестным результатом. Сначала проверьте её результат.',
      );
    if (
      all.some(
        (run) =>
          !runIds.includes(run.id) &&
          run.status === 'paused' &&
          selection.affectedVersions.includes(run.learningVersion),
      )
    )
      blockers.push(
        'Другая задача на паузе использует эти знания. Сначала продолжите или остановите её.',
      );
    let artifacts = 0,
      backups = 0,
      exports = 0;
    for (const id of runIds) {
      artifacts += await fileCount(join(this.sessions.directory, 'artifacts', id));
      backups += await fileCount(join(this.sessions.directory, 'file-backups', id));
    }
    for (const id of selection.candidateIds) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      try {
        const info = await lstat(
          join(this.sessions.directory, 'exports', 'Урок Harness ' + id + '.md'),
        );
        if (info.isFile() || info.isSymbolicLink()) exports++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const counts = { artifacts, backups, exports };
    return {
      sessionId: runs[0]!.sessionId,
      runIds,
      runs: runs.length,
      ...counts,
      lessons: selection.candidateIds.length,
      evidence: selection.evidenceIds.length,
      available: !blockers.length,
      blockers,
      previewToken: hash({ runs, state, selection, counts }),
    };
  }

  /** Подтверждение привязано к содержимому preview; изменившиеся данные требуют нового просмотра. */
  async purge(runId: string, previewToken: string) {
    const previous = this.sessions.purgeRecord(runId);
    if (previous?.complete && previous.previewToken === previewToken)
      return { purged: true, sessionId: previous.sessionId, runs: previous.runIds.length };
    return this.scheduler.schedule('write', async () => {
      const queued = this.sessions.purgeRecord(runId);
      if (queued?.complete && queued.previewToken === previewToken)
        return { purged: true, sessionId: queued.sessionId, runs: queued.runIds.length };
      const unlockSessions = await this.sessions.beginMaintenance(() => {
        // Проверка выполняется после ранее начатой записи, до блокировки работающих задач.
        if (
          this.runtime.busy() ||
          this.sessions
            .list(true)
            .some((run) => ['running', 'awaiting_approval'].includes(run.status))
        )
          throw new Error('Сначала остановите работающие задачи и дождитесь их остановки.');
      });
      let unlockLearning: (() => void) | undefined, unlockStore: (() => void) | undefined;
      let intentStarted = false,
        complete = false;
      try {
        unlockLearning = this.learning.beginMaintenance();
        unlockStore = await this.learningStore.beginMaintenance();
        const preview = await this.preview(runId);
        if (!preview.available) throw new Error(preview.blockers.join('\n'));
        if (preview.previewToken !== previewToken)
          throw new Error(
            'Состав беседы или знаний изменился. Откройте предпросмотр удаления заново.',
          );
        const { runs, selection } = this.plan(runId);
        const record: PurgeRecord = {
          schemaVersion: 1,
          sessionId: preview.sessionId,
          runIds: preview.runIds,
          requestDigests: runs.map((run) => hash(run.requestKey)),
          candidateIds: selection.candidateIds,
          evidenceIds: selection.evidenceIds,
          reportIds: selection.reportIds,
          previewToken,
          complete: false,
        };
        // Даже неясный исход записи маркера запрещает новые изменения до восстановления.
        intentStarted = true;
        await this.sessions.recordPurge(record);
        await this.learningStore.purge(record);
        await this.sessions.purgeFiles(record);
        record.complete = true;
        await this.sessions.recordPurge(record);
        complete = true;
        return { purged: true, sessionId: preview.sessionId, runs: preview.runs };
      } catch (error) {
        if (intentStarted)
          throw new Error(
            'Удаление прервалось. Перезапустите локальный сервис: очистка продолжится автоматически.',
            { cause: error },
          );
        throw error;
      } finally {
        if (!intentStarted || complete) {
          unlockStore?.();
          unlockLearning?.();
          unlockSessions();
        }
      }
    });
  }

  private plan(runId: string) {
    const sessionId = this.sessions.get(runId).sessionId;
    const runs = this.sessions.list(true).filter((run) => run.sessionId === sessionId);
    const state = this.learningStore.read();
    return {
      runs,
      state,
      selection: learningPurgePlan(
        state,
        runs.map((run) => run.id),
      ),
    };
  }
}

/** Завершает записанный каскад до загрузки сессий и запуска фонового обучения. */
export async function recoverPurges(directory: string): Promise<void> {
  const pending = (await readPurgeRecords(directory)).filter((record) => !record.complete);
  if (!pending.length) return;
  const learning = new FileLearningStore(directory);
  await learning.initialize();
  for (const record of pending) {
    await learning.purge(record);
    await removeRunFiles(directory, record);
    await writePurgeRecord(directory, { ...record, complete: true });
  }
}

async function fileCount(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}
