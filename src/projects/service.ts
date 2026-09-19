import { realpath } from 'node:fs/promises';
import { hash, id, message } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { isWithin } from '../configuration/loader.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { DraftScope } from '../sessions/drafts.js';
import { projectInputs } from './schema.js';
import type { ProjectInput, ProjectRecord, ProjectView } from './types.js';
import { ProjectCoordinator } from './coordinator.js';
import { planningMessage, replacePlan, validatePlan } from './plans.js';
import { projectView } from './view.js';
import { ProjectControls } from './controls.js';

export interface ProjectMaintenancePort {
  receipt(
    projectId: string,
    previewToken: string,
  ): Promise<{ purged: true; projectId: string; runs: number } | undefined>;
  preview(projectId: string): Promise<{
    projectId: string;
    previewToken: string;
    available: boolean;
    blockers: string[];
    runs: number;
    sessions: number;
    artifacts: number;
  }>;
  purge(
    project: ProjectRecord,
    previewToken: string,
  ): Promise<{ purged: true; projectId: string; runs: number }>;
}
/** Локальные решения человека проверяют ревизию; модель не получает этот сервис как инструмент. */
export class ProjectService {
  readonly controls: ProjectControls;
  maintenance?: ProjectMaintenancePort;
  constructor(
    readonly coordinator: ProjectCoordinator,
    private readonly configuration: () => Promise<ConfigSnapshot>,
    private readonly activeLearning: () => string,
  ) {
    this.controls = new ProjectControls(this);
  }
  get store() {
    return this.coordinator.options.store;
  }
  get runs() {
    return this.coordinator.options.runs;
  }
  get leases() {
    return this.coordinator.options.leases;
  }
  /** Создаёт только проект; исследование и исполнение начинаются отдельными действиями. */
  create(input: ProjectInput<'create'>): Promise<ProjectView> {
    const request = projectInputs.create.parse(input);
    return this.coordinator.serial.run(async () => {
      this.store.assertRequestAllowed(request.requestKey);
      const existing = this.store.findRequest(request.requestKey);
      if (existing) {
        const project = await this.store.get(existing);
        if (project.requestHash !== hash(request))
          throw new ApplicationError(
            'PROJECT_CONFLICT',
            'Ключ запроса уже использован для другой цели.',
          );
        return this.view(project);
      }
      const config = await this.configuration(),
        workspace = await realpath(request.workspace),
        profile = request.profile ?? config.value.defaultProfile;
      if (!config.value.workspaces.some((root) => isWithin(root, workspace)))
        throw new ApplicationError(
          'INVALID_REQUEST',
          'Выбранная папка не разрешена конфигурацией.',
        );
      if (!config.value.profiles[profile])
        throw new ApplicationError('INVALID_REQUEST', 'Профиль модели отсутствует в конфигурации.');
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        schemaVersion: 1,
        id: id(),
        revision: 0,
        requestKey: request.requestKey,
        requestHash: hash(request),
        title: request.title,
        goal: request.goal,
        workspace,
        profile,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        config,
        learningVersion: this.activeLearning(),
        stages: {},
        runIds: [],
        reports: [],
        phase: 'planning',
        receipts: {},
      };
      return this.view(
        await this.coordinator.save(
          project,
          'project.created',
          'Проект создан. Сначала составьте и примите план.',
        ),
      );
    });
  }
  /** Списки читают каталог, сохраняя задержку меню независимой от истории запусков. */
  async list(input: ProjectInput<'list'> = {}) {
    const request = projectInputs.list.parse(input),
      query = request.query.toLocaleLowerCase();
    const all = this.store
      .catalog(request.includeArchived)
      .filter(
        (item) => !query || (item.title + ' ' + item.goal).toLocaleLowerCase().includes(query),
      );
    const pages = Math.max(1, Math.ceil(all.length / request.limit)),
      page = Math.min(request.page, pages - 1);
    return {
      items: all.slice(page * request.limit, (page + 1) * request.limit),
      total: all.length,
      page,
      pages,
    };
  }
  /** Живой просмотр не увеличивает ревизию проекта и не сбрасывает подтверждения плана. */
  async detail(input: ProjectInput<'detail'>) {
    const request = projectInputs.detail.parse(input);
    return this.view(await this.store.get(request.projectId), request.cursor, request.eventLimit);
  }
  /** Новый запуск исследования имеет принудительные ограничения чтения в runtime. */
  plan(input: ProjectInput<'plan'>) {
    return this.mutate('plan', input, async (project, request) => {
      this.requireIdle(project);
      await this.requireKnownOperations(project);
      if (project.status === 'completed' || project.status === 'cancelled')
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Завершённый проект доступен для просмотра.',
        );
      if (request.goal) project.goal = request.goal;
      project.status = 'planning';
      project.phase = 'planning';
      delete project.intent;
      return this.coordinator.start(project, {
        kind: 'planning',
        attempt: 0,
        message: planningMessage(project, request.feedback),
      });
    });
  }
  /** Редактирование критериев создаёт новую версию, требующую принятия человеком. */
  editPlan(input: ProjectInput<'editPlan'>) {
    return this.mutate('editPlan', input, async (project, request) => {
      this.requireIdle(project);
      await this.requireKnownOperations(project);
      if (['completed', 'cancelled'].includes(project.status))
        throw new ApplicationError('PROJECT_CONFLICT', 'Создайте новый проект для новой работы.');
      replacePlan(
        project,
        validatePlan(request.plan, project.config, this.coordinator.options.tools),
      );
      return this.coordinator.save(project, 'project.plan_edited', 'Создана новая версия плана.');
    });
  }
  /** Принятие фиксирует команды и исходное состояние до первой попытки изменить код. */
  acceptPlan(input: ProjectInput<'acceptPlan'>) {
    return this.mutate('acceptPlan', input, async (project, request) => {
      if (project.status !== 'ready' || project.plan?.version !== request.expectedPlanVersion)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'План изменился. Просмотрите актуальную версию.',
        );
      validatePlan(
        project.plan && {
          stages: project.plan.stages,
          maxCorrections: project.plan.maxCorrections,
          fixBaselineFailures: project.plan.fixBaselineFailures,
        },
        project.config,
        this.coordinator.options.tools,
      );
      this.leases.acquire(project.id, project.workspace);
      try {
        const snapshot = await this.coordinator.capture(project);
        project.baseline ??= snapshot;
        project.checkpoint = snapshot;
        project.acceptedVersion = project.plan.version;
        project.acceptedAt = new Date().toISOString();
        project.status = 'running';
        project.phase = 'baseline';
        delete project.reason;
        delete project.reasonCode;
        project = await this.coordinator.save(
          project,
          'project.plan_accepted',
          'План принят. Сначала проверяем исходный проект.',
        );
        return await this.coordinator.advance(project);
      } catch (error) {
        if (!project.intent?.runId || !this.runs.busy(project.intent.runId))
          this.leases.release(project.id);
        throw error;
      }
    });
  }
  pause(input: ProjectInput<'pause'>) {
    return this.controls.pause(input);
  }
  resume(input: ProjectInput<'resume'>) {
    return this.controls.resume(input);
  }
  cancel(input: ProjectInput<'cancel'>) {
    return this.controls.cancel(input);
  }
  message(input: ProjectInput<'message'>) {
    return this.controls.message(input);
  }
  manualCheck(input: ProjectInput<'manualCheck'>) {
    return this.controls.manualCheck(input);
  }
  recheck(input: ProjectInput<'recheck'>) {
    return this.controls.recheck(input);
  }
  accept(input: ProjectInput<'accept'>) {
    return this.controls.accept(input);
  }
  resolve(input: ProjectInput<'resolve'>) {
    return this.controls.resolve(input);
  }
  archive(input: ProjectInput<'archive'>) {
    return this.controls.archive(input);
  }
  /** Координация каскада принадлежит application и подключается при сборке приложения. */
  async purgePreview(input: ProjectInput<'purgePreview'>) {
    const request = projectInputs.purgePreview.parse(input);
    if (!this.maintenance)
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Удаление проектов недоступно.');
    return this.maintenance.preview(request.projectId);
  }
  async purge(input: ProjectInput<'purge'>) {
    const request = projectInputs.purge.parse(input);
    return this.coordinator.serial.run(async () => {
      const previous = await this.maintenance?.receipt(request.projectId, request.previewToken);
      if (previous) return previous;
      const project = await this.store.get(request.projectId);
      if (project.revision !== request.expectedRevision)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Состав проекта изменился. Повторите просмотр удаления.',
        );
      this.requireIdle(project);
      if (!this.maintenance)
        throw new ApplicationError('STORAGE_UNAVAILABLE', 'Удаление проектов недоступно.');
      return this.maintenance.purge(project, request.previewToken);
    });
  }
  /** Очередь проекта берётся до очереди файлов сессий, исключая инверсию блокировок черновиков. */
  withDraftScope<T>(scope: DraftScope, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.serial.run(async () => {
      if (scope.projectId) {
        const project = await this.store.get(scope.projectId);
        if (
          project.deletedAt ||
          project.workspace !== scope.workspace ||
          project.profile !== scope.profile ||
          (scope.stageId && !project.stages[scope.stageId])
        )
          throw new ApplicationError(
            'PROJECT_CONFLICT',
            'Папка или этап черновика больше не соответствует проекту.',
          );
      }
      return operation();
    });
  }
  /** Результат повторного запроса возвращается до проверки устаревшей ревизии. */
  mutate<
    K extends Exclude<
      keyof typeof projectInputs,
      'create' | 'list' | 'detail' | 'purgePreview' | 'purge'
    >,
  >(
    kind: K,
    input: ProjectInput<K>,
    work: (
      project: ProjectRecord,
      input: ReturnType<(typeof projectInputs)[K]['parse']>,
    ) => Promise<ProjectRecord>,
  ): Promise<ProjectView> {
    const request = projectInputs[kind].parse(input);
    return this.coordinator.serial.run(async () => {
      let project = await this.store.get(request.projectId);
      const binding = hash({ kind, input: request }),
        previous = project.receipts[request.requestKey];
      if (previous) {
        if (previous !== binding)
          throw new ApplicationError(
            'PROJECT_CONFLICT',
            'Ключ запроса уже использован для другого действия.',
          );
        if (kind === 'message')
          project = await this.controls.deliverMessages(project, request.requestKey);
        return this.view(project);
      }
      if (project.revision !== request.expectedRevision)
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Проект изменился в другом окне. Просмотрите текущее состояние.',
        );
      project.receipts[request.requestKey] = binding;
      try {
        return this.view(
          await work(project, request as ReturnType<(typeof projectInputs)[K]['parse']>),
        );
      } catch (error) {
        const saved = await this.store.get(request.projectId);
        if (
          saved.receipts[request.requestKey] === binding &&
          ['running', 'planning', 'pausing'].includes(saved.status) &&
          !saved.runIds.some((runId) => this.runs.busy(runId))
        ) {
          saved.status = 'paused';
          saved.reason = message(error);
          saved.reasonCode = 'ACTION_FAILED';
          await this.coordinator.save(saved, 'project.action_failed', saved.reason);
          this.leases.release(saved.id);
        }
        throw error;
      }
    });
  }
  /** Проверяет остановку исполнителей, а не только видимую метку состояния проекта. */
  requireIdle(project: ProjectRecord): void {
    if (
      ['running', 'planning', 'pausing'].includes(project.status) ||
      project.runIds.some((runId) => this.runs.busy(runId))
    )
      throw new ApplicationError(
        'TASK_BUSY',
        'Сначала приостановите проект и дождитесь завершения текущих операций.',
      );
  }
  /** Замена плана не скрывает операции, исход которых ещё должен проверить человек. */
  async requireKnownOperations(project: ProjectRecord): Promise<void> {
    for (const runId of project.runIds) {
      const run = await this.runs.inspect(runId);
      if (
        Object.values(run.invocations).some(
          (call) => call.status === 'unknown' || call.status === 'started',
        )
      )
        throw new ApplicationError(
          'UNKNOWN_OUTCOME',
          'Сначала проверьте неизвестный результат операции.',
        );
    }
  }
  view(project: ProjectRecord, cursor = 0, eventLimit = 30) {
    return projectView(
      project,
      this.store,
      this.runs,
      this.coordinator.options.workspace,
      cursor,
      eventLimit,
    );
  }
  busy() {
    return this.store
      .catalog(true)
      .some((project) => ['running', 'planning', 'pausing'].includes(project.status));
  }
  close() {
    return this.coordinator.close();
  }
}
