import { id } from '../shared/primitives.js';
import type { ProjectIntent, ProjectRecord, ProjectSnapshot } from './types.js';
import type { ProjectChangeSet } from './change-types.js';
import type { ProjectWorkspace } from './workspace.js';

/** Связывает файловые точки с жизненным циклом; исполнение и журналирование остаются у координатора. */
export class ProjectChangeRecorder {
  constructor(private readonly workspace: ProjectWorkspace) {}

  /** Отсутствие настройки в исторической записи сохраняет прежний режим без копий текста. */
  capture(project: ProjectRecord): Promise<ProjectSnapshot> {
    return this.workspace.capture(
      project.id,
      project.workspace,
      project.config.value.tools.deniedPaths,
      project.capture ? { settings: project.capture, config: project.config.value } : undefined,
    );
  }

  /** Начальная точка и идентификатор интервала записываются до запуска исполнителя. */
  async begin(project: ProjectRecord, intent: Omit<ProjectIntent, 'requestKey'>): Promise<void> {
    if (intent.kind === 'planning') return;
    intent.before ??= await this.capture(project);
    const interval: ProjectChangeSet = {
      id: id(),
      kind: intent.kind,
      outcome: 'pending',
      before: intent.before,
      stageId: intent.stageId,
      stageTitle: project.plan?.stages.find((stage) => stage.id === intent.stageId)?.title,
      attempt: intent.attempt,
      planVersion: project.plan?.version ?? 0,
    };
    intent.changeSetId = interval.id;
    (project.changeSets ??= []).push(interval);
  }

  /** Связывает уже подготовленный интервал с единственным запуском после устойчивого создания. */
  link(project: ProjectRecord): void {
    const interval = project.changeSets?.find((item) => item.id === project.intent?.changeSetId);
    if (interval && project.intent?.runId) interval.runId = project.intent.runId;
  }

  /** Возвращает прежнюю завершённую точку либо сохраняет новую, привязанную к запуску. */
  async after(project: ProjectRecord): Promise<ProjectSnapshot> {
    const interval = project.changeSets?.find((entry) => entry.id === project.intent?.changeSetId);
    if (interval?.outcome === 'complete' && interval.after) return interval.after;
    return this.workspace.capture(
      project.id,
      project.workspace,
      project.config.value.tools.deniedPaths,
      project.capture
        ? {
            settings: project.capture,
            config: project.config.value,
            ...(project.intent?.runId && interval?.outcome === 'pending'
              ? {
                  link: {
                    runId: project.intent.runId,
                    changeSetId: interval.id,
                    kind: 'after' as const,
                  },
                }
              : {}),
          }
        : undefined,
    );
  }

  /** Завершает только ожидающий интервал; сохранённые сравнения никогда не переписываются. */
  finish(project: ProjectRecord, after: ProjectSnapshot, reportId?: string): void {
    const interval = project.changeSets?.find((item) => item.id === project.intent?.changeSetId);
    if (interval?.outcome === 'pending') {
      interval.after = after;
      interval.outcome = 'complete';
    }
    if (interval?.outcome === 'complete' && reportId) interval.reportId = reportId;
    this.overall(project, after);
  }

  /** Сохраняет новый общий интервал с постоянной исходной точкой даже после изменения плана. */
  overall(project: ProjectRecord, after: ProjectSnapshot): void {
    if (!project.baseline) return;
    const previous = project.changeSets?.at(-1);
    if (previous?.kind === 'project' && previous.after?.ref === after.ref) return;
    (project.changeSets ??= []).push({
      id: id(),
      kind: 'project',
      outcome: 'complete',
      before: project.baseline,
      after,
      planVersion: project.acceptedVersion ?? project.plan?.version ?? 0,
    });
  }

  /** Пауза имеет собственную точку, не выдавая её за окончание ещё живой попытки. */
  paused(project: ProjectRecord, after: ProjectSnapshot): void {
    const before = project.checkpoint ?? project.baseline;
    if (before)
      (project.changeSets ??= []).push({
        id: id(),
        kind: 'pause',
        outcome: 'complete',
        before,
        after,
        runId: project.intent?.runId,
        stageId: project.intent?.stageId,
        stageTitle: project.plan?.stages.find((stage) => stage.id === project.intent?.stageId)
          ?.title,
        attempt: project.intent?.attempt,
        planVersion: project.acceptedVersion ?? project.plan?.version ?? 0,
      });
    if (project.status === 'cancelled') this.finish(project, after);
    else this.overall(project, after);
  }

  /** Изменения между остановкой и продолжением показываются отдельным интервалом. */
  external(project: ProjectRecord, after: ProjectSnapshot): void {
    const before = project.checkpoint;
    if (!before || before.digest === after.digest) return;
    if (
      project.changeSets?.some(
        (entry) =>
          entry.kind === 'external' &&
          entry.before.ref === before.ref &&
          entry.after?.digest === after.digest,
      )
    )
      return;
    (project.changeSets ??= []).push({
      id: id(),
      kind: 'external',
      outcome: 'complete',
      before,
      after,
      planVersion: project.acceptedVersion ?? project.plan?.version ?? 0,
    });
  }

  /** Утраченную границу после аварии отмечает пробелом без повторного исполнения или нового снимка. */
  async recovered(project: ProjectRecord): Promise<void> {
    for (const interval of project.changeSets ?? []) {
      if (interval.outcome !== 'pending' || !interval.runId) continue;
      const saved = await this.workspace.content.findAfter(project.id, interval.runId, interval.id);
      if (saved) {
        await this.workspace.readEntries(project.id, saved.ref);
        interval.after = saved;
        interval.outcome = 'complete';
        continue;
      }
      interval.outcome = 'gap';
      interval.reason =
        'После прерывания точное состояние файлов на границе выполнения неизвестно.';
    }
  }

  /** Новая часть возобновлённой попытки начинается с текущей точки, не заполняя прежний пробел. */
  continued(project: ProjectRecord, before: ProjectSnapshot): void {
    const intent = project.intent;
    const previous = project.changeSets?.find((entry) => entry.id === intent?.changeSetId);
    if (!intent || intent.kind === 'planning' || previous?.outcome !== 'gap') return;
    const interval: ProjectChangeSet = {
      id: id(),
      kind: intent.kind,
      outcome: 'pending',
      before,
      planVersion: project.plan?.version ?? 0,
      stageId: intent.stageId,
      stageTitle: project.plan?.stages.find((stage) => stage.id === intent.stageId)?.title,
      attempt: intent.attempt,
      runId: intent.runId,
      reason: 'Продолжение после восстановления; предыдущая часть сохранена отдельно.',
    };
    intent.changeSetId = interval.id;
    (project.changeSets ??= []).push(interval);
  }
}
