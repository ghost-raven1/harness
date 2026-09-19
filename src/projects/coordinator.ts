import { ProjectChangeRecorder } from './change-recorder.js';
import { Serial, id, message } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import type { ProjectRunPort, ProjectRunStart } from '../sessions/project-run.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ProjectStore } from './store.js';
import { ProjectWorkspace } from './workspace.js';
import { WorkspaceLeases } from './workspace-leases.js';
import { allChecks, parsePlan, replacePlan, validatePlan } from './plans.js';
import { checkCalls, checkReport, correctionMessage } from './checks.js';
import type { ProjectIntent, ProjectRecord, ProjectStage, ProjectSnapshot } from './types.js';

export interface ProjectCoordinatorOptions {
  store: ProjectStore;
  runs: ProjectRunPort;
  workspace: ProjectWorkspace;
  leases: WorkspaceLeases;
  tools: ToolRegistry;
  onAccepted(project: ProjectRecord): Promise<void>;
}
/** Координатор запускает этапы только после завершения финализаторов предыдущего дерева. */
export class ProjectCoordinator {
  readonly serial = new Serial();
  readonly changes: ProjectChangeRecorder;
  private readonly unsubscribe: () => void;
  private closing = false;
  constructor(readonly options: ProjectCoordinatorOptions) {
    this.changes = new ProjectChangeRecorder(options.workspace);
    this.unsubscribe = options.runs.subscribeSettled((event) => {
      this.queueSettlement(event.runId, event.link.projectId);
    });
  }
  /** Фоновый исход и его диагностика входят в одну очередь, которую ожидает закрытие. */
  private queueSettlement(runId: string, projectId: string): void {
    void this.serial.run(async () => {
      try {
        await this.settled(runId);
      } catch (error) {
        await this.fail(projectId, error);
      }
    });
  }
  /** После аварии связывает сохранённое намерение с запуском, не возобновляя его автоматически. */
  async initialize(): Promise<void> {
    if (this.options.store.recoveryError) return;
    for (const entry of this.options.store.catalog(true)) {
      let project = await this.options.store.get(entry.projectId);
      if (project.deletedAt) continue;
      if (project.intent && !project.intent.runId) {
        const run = this.options.runs.find(project.intent.requestKey);
        if (run) {
          project.intent.runId = run.id;
          project.intent.sessionId = run.sessionId;
          if (!project.runIds.includes(run.id)) project.runIds.push(run.id);
          if (project.intent.kind === 'stage' && project.intent.stageId)
            Object.assign(project.stages[project.intent.stageId]!, {
              runId: run.id,
              sessionId: run.sessionId,
              status: 'running',
            });
        }
      }
      this.changes.link(project);
      if (['running', 'pausing', 'planning'].includes(project.status)) {
        await this.changes.recovered(project);
        project.status = 'paused';
        project.reason = 'Работа прервалась. Проверьте состояние и продолжите проект.';
        project.reasonCode = 'RECOVERED';
        project = await this.save(project, 'project.recovered', project.reason);
      }
      if (project.status === 'completed') await this.options.onAccepted(project);
    }
  }
  /** Удерживает ревизию только на время перехода проекта, не на время работы модели. */
  save(project: ProjectRecord, type: string, text: string): Promise<ProjectRecord> {
    return this.options.store.save(project, project.revision, type, text);
  }
  /** Сохраняет намерение до создания запуска; повтор использует прежний ключ запроса. */
  async start(
    project: ProjectRecord,
    intent: Omit<ProjectIntent, 'requestKey'>,
  ): Promise<ProjectRecord> {
    await this.changes.begin(project, intent);
    project.intent = { ...intent, requestKey: project.id + ':' + id() };
    project = await this.save(
      project,
      'project.execution_prepared',
      'Подготовлен запуск: ' + intent.kind,
    );
    return this.dispatchIntent(project);
  }
  /** Восстанавливает тот же запуск по ключу, даже если авария произошла до сохранения runId. */
  async dispatchIntent(project: ProjectRecord): Promise<ProjectRecord> {
    const intent = project.intent!;
    this.options.leases.acquire(project.id, project.workspace);
    const stage = project.plan?.stages.find((item) => item.id === intent.stageId);
    const input: ProjectRunStart = {
      link: {
        projectId: project.id,
        planVersion: project.plan?.version ?? 1,
        stageId: intent.stageId,
        attempt: intent.attempt,
        kind: intent.kind,
      },
      requestKey: intent.requestKey,
      workspace: project.workspace,
      profile: project.profile,
      config: project.config,
      learningVersion: project.learningVersion,
      role: intent.kind === 'stage' ? stage!.role : project.config.value.defaultRole,
      message: intent.message,
      sessionId: intent.sessionId,
      expectedParentRunId: intent.expectedParentRunId,
      ...(intent.kind === 'checks' ? { calls: checkCalls(intent) } : {}),
      ...(intent.kind === 'stage'
        ? {
            dependencies: (stage?.dependsOn ?? []).flatMap((stageId) => {
              const state = project.stages[stageId];
              return state?.runId ? [{ runId: state.runId, title: stageId }] : [];
            }),
          }
        : {}),
    };
    const reference = await this.options.runs.start(input);
    project.intent = { ...intent, ...reference };
    this.changes.link(project);
    if (!project.runIds.includes(reference.runId)) project.runIds.push(reference.runId);
    if (intent.kind === 'stage')
      Object.assign(project.stages[intent.stageId!]!, {
        runId: reference.runId,
        sessionId: reference.sessionId,
        status: 'running',
      });
    project = await this.save(
      project,
      'project.execution_started',
      'Запущен ' +
        (stage?.title ??
          (intent.phase === 'baseline' ? 'проверочный прогон исходного проекта' : intent.kind)),
    );
    if (!this.options.runs.busy(reference.runId))
      queueMicrotask(() => this.queueSettlement(reference.runId, project.id));
    return project;
  }
  /** Выбирает единственный следующий этап; результаты зависимостей уже сохранены. */
  async advance(project: ProjectRecord): Promise<ProjectRecord> {
    if (this.closing || project.status !== 'running') return project;
    if (project.intent) return this.dispatchIntent(project);
    this.options.leases.acquire(project.id, project.workspace);
    if (project.phase === 'baseline') {
      const checks = allChecks(project.plan!);
      if (checks.length) return this.startChecks(project, 'baseline', checks);
      project.baselinePassed = true;
      project.phase = 'stages';
      project = await this.save(
        project,
        'project.baseline',
        'Автоматических исходных проверок нет.',
      );
    }
    if (project.phase === 'stages') {
      const stage = project.plan!.stages.find(
        (item) => project.stages[item.id]!.status !== 'completed',
      );
      if (stage) {
        if (stage.dependsOn.some((id) => project.stages[id]?.status !== 'completed'))
          throw new ApplicationError(
            'INVALID_PLAN',
            'Предыдущие зависимости этапа ещё не завершены.',
          );
        if (project.stages[stage.id]!.status === 'checking')
          return this.verifyStage(project, stage);
        return this.startStage(project, stage);
      }
      project.phase = 'final';
      project = await this.save(
        project,
        'project.final_checks',
        'Все этапы выполнены. Проверяем итоговое состояние.',
      );
    }
    if (project.phase === 'acceptance') return this.prepareReview(project);
    if (project.phase === 'final') {
      const checks = allChecks(project.plan!);
      if (checks.length) return this.startChecks(project, 'final', checks);
      return this.prepareReview(project);
    }
    return project;
  }
  /** Исправление продолжает сессию этапа; новые критерии через этот путь не принимаются. */
  async startStage(
    project: ProjectRecord,
    stage: ProjectStage,
    correction?: string,
  ): Promise<ProjectRecord> {
    const state = project.stages[stage.id]!;
    const task = [
      'Цель проекта: ' + project.goal,
      'Этап: ' + stage.title,
      stage.task,
      'Ожидаемый результат: ' + stage.expectedResult,
      'Принятые проверки (их запускает Harness после твоего ответа): ' +
        JSON.stringify(stage.verification),
      ...stage.dependsOn.map(
        (id) => 'Результат ' + id + ': ' + (project.stages[id]?.summary ?? 'Сохранён в артефакте.'),
      ),
      correction ?? '',
      'Не изменяй критерии приёмки. Заверши свои подзадачи перед финальным ответом.',
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.start(project, {
      kind: 'stage',
      stageId: stage.id,
      attempt: state.attempt,
      message: task,
      sessionId: state.sessionId,
      expectedParentRunId: state.runId,
    });
  }
  private async startChecks(
    project: ProjectRecord,
    phase: 'baseline' | 'stage' | 'final',
    checks: NonNullable<ProjectIntent['checks']>,
    stageId?: string,
  ) {
    const before = await this.capture(project);
    if (stageId) project.stages[stageId]!.status = 'checking';
    return this.start(project, {
      kind: 'checks',
      phase,
      stageId,
      attempt: stageId ? project.stages[stageId]!.attempt : project.reports.length,
      message: 'Выполнить принятые проверки ' + phase,
      checks,
      before,
    });
  }
  /** Завершённый run обрабатывается повторно безопасно: сохранённое намерение связывает исход. */
  async settled(runId: string): Promise<void> {
    const run = await this.options.runs.inspect(runId);
    if (!run.project || this.options.runs.busy(runId)) return;
    let project = await this.options.store.get(run.project.projectId);
    if (project.intent?.runId !== runId || project.deletedAt || project.status === 'completed')
      return;
    const intent = project.intent,
      stopping = project.status === 'pausing' || project.status === 'paused';
    if (project.status === 'cancelled') {
      await this.checkpoint(project);
      return;
    }
    if (run.status === 'paused' || run.status === 'cancelled') {
      project.status = 'paused';
      project.reason = run.error ?? 'Выполнение этапа приостановлено.';
      project.reasonCode = Object.values(run.invocations).some((i) => i.status === 'unknown')
        ? 'UNKNOWN_OUTCOME'
        : (run.pauseReason ?? 'PAUSED');
      await this.checkpoint(project);
      return;
    }
    if (intent.kind === 'planning') {
      if (run.status !== 'completed')
        return this.pauseFailure(
          project,
          run.error ?? 'Не удалось составить план.',
          'PLANNING_FAILED',
        );
      try {
        replacePlan(
          project,
          validatePlan(parsePlan(run.result ?? ''), project.config, this.options.tools),
        );
      } catch (error) {
        return this.pauseFailure(project, message(error), 'INVALID_PLAN');
      }
      project = await this.save(
        project,
        'project.plan_proposed',
        'План готов. Исполнение ждёт принятия человеком.',
      );
      this.options.leases.release(project.id);
      return;
    }
    if (intent.kind === 'stage') {
      const after = await this.changes.after(project);
      this.changes.finish(project, after);
      if (run.status !== 'completed')
        return this.pauseFailure(project, run.error ?? 'Этап не завершён.', 'STAGE_FAILED');
      project.stages[intent.stageId!]!.summary = (run.result ?? '').slice(0, 4000);
      project.stages[intent.stageId!]!.status = 'checking';
      delete project.intent;
      project = await this.save(
        project,
        'project.stage_result',
        'Результат этапа сохранён; требуется проверка.',
      );
      if (stopping) {
        project.status = 'paused';
        await this.checkpoint(project);
        return;
      }
      await this.verifyStage(project, project.plan!.stages.find((s) => s.id === intent.stageId)!);
      return;
    }
    const after = await this.changes.after(project);
    const report = checkReport(intent, run, after);
    this.changes.finish(project, after, report.id);
    const previousReport = project.reports.findIndex((item) => item.runId === report.runId);
    if (previousReport >= 0) project.reports[previousReport] = report;
    else project.reports.push(report);
    project.checkpoint = after;
    if (report.status !== 'passed') {
      if (
        report.status === 'unknown' ||
        report.checks.some((c) => ['denied', 'cancelled'].includes(c.status))
      )
        return this.pauseFailure(
          project,
          'Проверка требует решения человека.',
          'UNKNOWN_OR_DENIED',
        );
      delete project.intent;
      if (intent.phase === 'baseline') {
        if (!project.plan!.fixBaselineFailures)
          return this.pauseFailure(
            project,
            'Исходные проверки не проходят. Включите их исправление в новую версию плана.',
            'BASELINE_FAILED',
          );
        project.baselinePassed = false;
        project.phase = 'stages';
      } else {
        const stage =
          project.plan!.stages.find((s) => s.id === intent.stageId) ?? project.plan!.stages.at(-1)!;
        const state = project.stages[stage.id]!;
        state.status = 'blocked';
        project.phase = 'stages';
        if (stopping || state.attempt >= project.plan!.maxCorrections)
          return this.pauseFailure(
            project,
            'Проверка не прошла. Автоматические исправления остановлены; изучите отчёт.',
            'CORRECTIONS_EXHAUSTED',
          );
        project = await this.save(
          project,
          'project.check_result',
          'Проверка не пройдена; требуется исправление.',
        );
        project.stages[stage.id]!.attempt++;
        await this.startStage(project, stage, correctionMessage(report));
        return;
      }
    } else {
      delete project.intent;
      if (intent.phase === 'baseline') {
        project.baselinePassed = true;
        project.phase = 'stages';
      } else if (intent.phase === 'stage') project.stages[intent.stageId!]!.status = 'completed';
      else {
        if (stopping) {
          project.status = 'paused';
          project.phase = 'acceptance';
          await this.checkpoint(project);
          return;
        }
        await this.prepareReview(project, after);
        return;
      }
    }
    project = await this.save(project, 'project.stage_verified', 'Результаты проверки сохранены.');
    if (stopping) {
      project.status = 'paused';
      await this.checkpoint(project);
      return;
    }
    await this.advance(project);
  }
  /** Финальная приёмка относится к одной версии файлов, включая ручные проверки. */
  async prepareReview(project: ProjectRecord, verified?: ProjectSnapshot): Promise<ProjectRecord> {
    if (project.plan!.stages.some((stage) => project.stages[stage.id]?.status !== 'completed'))
      throw new ApplicationError(
        'PROJECT_CONFLICT',
        'Сначала завершите и проверьте все этапы проекта.',
      );
    const current = verified ?? (await this.capture(project));
    const finalReport = [...project.reports]
      .reverse()
      .find((report) => report.phase === 'final' && report.status === 'passed');
    if (
      !verified &&
      allChecks(project.plan!).length &&
      finalReport?.workspaceRevision !== current.digest
    ) {
      project.phase = 'final';
      project.status = 'running';
      delete project.resultSnapshot;
      project = await this.save(
        project,
        'project.verification_stale',
        'Итоговые проверки устарели; запускаем их для текущих файлов.',
      );
      return this.advance(project);
    }
    this.changes.overall(project, current);
    project.resultSnapshot = current;
    project.checkpoint = project.resultSnapshot;
    project.phase = 'acceptance';
    const stale = project.plan!.stages.find(
      (s) =>
        s.verification.kind === 'manual' &&
        project.stages[s.id]?.manualRevision !== project.resultSnapshot!.digest,
    );
    project.status = stale ? 'paused' : 'review';
    project.reasonCode = stale ? 'FINAL_MANUAL_CHECK' : undefined;
    project.reason = stale
      ? 'Подтвердите ручные проверки для итогового состояния файлов.'
      : 'Все обязательные проверки пройдены. Результат ждёт вашей приёмки.';
    project = await this.save(project, 'project.review', project.reason);
    this.options.leases.release(project.id);
    return project;
  }
  /** Проверка уже сохранённого ответа не повторяет работу исполнителя после паузы. */
  private async verifyStage(project: ProjectRecord, stage: ProjectStage): Promise<ProjectRecord> {
    if (stage.verification.kind === 'commands')
      return this.startChecks(project, 'stage', stage.verification.checks, stage.id);
    project.stages[stage.id]!.status = 'manual';
    project.status = 'paused';
    project.reason = 'Проверьте результат этапа: ' + stage.verification.instructions;
    project.reasonCode = 'MANUAL_CHECK';
    project.resultSnapshot = await this.capture(project);
    return this.checkpoint(project);
  }
  capture(project: ProjectRecord) {
    return this.changes.capture(project);
  }
  /** Пауза освобождает папку только после завершения всех исполнителей и сохранения её отпечатка. */
  async checkpoint(project: ProjectRecord): Promise<ProjectRecord> {
    try {
      const current = await this.capture(project);
      this.changes.paused(project, current);
      project.checkpoint = current;
    } catch (error) {
      project.reason =
        (project.reason ?? 'Проект приостановлен.') +
        ' Не удалось зафиксировать папку: ' +
        message(error);
    }
    project = await this.save(project, 'project.paused', project.reason ?? 'Проект приостановлен.');
    this.options.leases.release(project.id);
    return project;
  }
  private async pauseFailure(project: ProjectRecord, reason: string, code: string): Promise<void> {
    project.status = 'paused';
    project.reason = reason;
    project.reasonCode = code;
    await this.checkpoint(project);
  }
  /** Ошибка фонового перехода становится видимой диагностикой, а не потерянным обещанием. */
  private async fail(projectId: string, error: unknown): Promise<void> {
    try {
      const project = await this.options.store.get(projectId);
      await this.pauseFailure(project, message(error), 'PROJECT_FAILURE');
    } catch {
      this.options.store.recoveryError =
        'Не удалось сохранить состояние проекта. Перезапустите сервис после проверки диска.';
    }
  }
  /** Закрытие не запускает новые этапы; runtime отдельно завершит уже принятые операции. */
  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribe();
    await this.serial.run(async () => {});
  }
}
