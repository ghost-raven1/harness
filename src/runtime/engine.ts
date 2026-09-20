import type { ExecutionObserver } from '../insights/ports.js';
import { observedProvider, RunObservations } from './observations.js';
import { ApplicationError } from '../shared/application-error.js';
import { UsageLedger } from './usage.js';
import {
  IterationSettings,
  iterationProgress,
  validateIterationLimit,
  assertExpectedLimit,
  type IterationStatus,
} from './iterations.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { SessionStore } from '../sessions/ports.js';
import type { RunRecord, RunStatus } from '../sessions/types.js';
import { requiresOutcomeReview } from '../sessions/invocations.js';
import type { LearningStore } from '../learning/types.js';
import type { ModelProvider } from '../providers/types.js';
import { ProviderError } from '../providers/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PolicyService } from '../policy/service.js';
import type { ContextService } from '../context/service.js';
import type { InvocationExecutor } from './executor.js';
import { AgentCoordinator } from '../agents/coordinator.js';
import { AgentLoop } from './agent-loop.js';
import { RunFactory, type RunInput } from './run-factory.js';
import { Serial } from '../shared/primitives.js';
import { RunInbox, type RunMessageInput } from './messages.js';
import { realpath } from 'node:fs/promises';
import { RuntimeExecutions } from './executions.js';
import { CheckLoop } from './check-loop.js';
import { RunPausedError } from '../shared/run-pause.js';
import { prepareResume } from './resume.js';
import type {
  ProjectRunPort,
  ProjectRunStart,
  RunSettled,
  WorkspaceAccess,
} from '../sessions/project-run.js';

export { runInputSchema, type RunInput } from './run-factory.js';

interface RuntimeServices {
  observer?: ExecutionObserver;
  configFile: string;
  initialConfig: ConfigSnapshot;
  store: SessionStore;
  learning: LearningStore;
  provider: ModelProvider;
  context: ContextService;
  registry: ToolRegistry;
  policy: PolicyService;
  executor: InvocationExecutor;
}

/** Управляет жизненным циклом запусков; исполнение ролей делегирует циклу и координатору. */
export class HarnessRuntime {
  // Снимок состояния и регистрация исполнителя образуют один переход для команд CLI.
  private readonly lifecycle = new Serial();
  private closing?: Promise<void>;
  private readonly failures = new Map<string, unknown>();
  private readonly executions: RuntimeExecutions;
  readonly usage: UsageLedger;
  readonly observations: RunObservations;
  private readonly iterations: IterationSettings;
  private readonly agents: AgentCoordinator;
  private readonly loop: AgentLoop;
  private readonly factory: RunFactory;
  private readonly inbox: RunInbox;
  private readonly capability = Symbol('project-runtime');
  private readonly settled = new Set<(event: RunSettled) => void>();
  private access: WorkspaceAccess = {
    reserve: () => () => undefined,
    assertWrite: () => undefined,
  };
  readonly store: SessionStore;
  private readonly initialConfig: ConfigSnapshot;
  /** Вызывается после остановки дерева; по умолчанию завершение не запускает дополнительные действия. */
  private terminal: (runId: string) => Promise<void> = async () => undefined;

  constructor(services: RuntimeServices) {
    this.store = services.store;
    this.observations = new RunObservations(services.observer);
    this.inbox = new RunInbox(services.store);
    this.usage = new UsageLedger(services.store);
    this.iterations = new IterationSettings(services.store.stateFiles);
    this.initialConfig = services.initialConfig;
    this.factory = new RunFactory(
      services.configFile,
      services.initialConfig,
      services.store,
      services.learning,
      this.iterations,
    );
    this.agents = new AgentCoordinator(
      services.store,
      (runId, agentId, signal) => this.loop.run(runId, agentId, signal),
      services.observer,
    );
    const checks = new CheckLoop(services.store, services.executor, (runId) =>
      this.executions.checkpoint(runId),
    );
    this.executions = new RuntimeExecutions({
      store: services.store,
      observations: this.observations,
      agents: this.agents,
      failures: this.failures,
      executeRoot: (runId, signal) =>
        services.store.get(runId).project?.kind === 'checks'
          ? checks.run(runId, signal)
          : this.loop.run(runId, services.store.get(runId).rootAgentId, signal),
      terminal: (runId) => this.terminal(runId),
      settled: (runId) => this.notifySettled(runId),
    });
    services.executor.setExecutionControl({
      checkpoint: (runId) => this.executions.checkpoint(runId),
      waitingSignal: (runId, signal) => this.executions.waitingSignal(runId, signal),
      assertWrite: (run) => this.access.assertWrite(run),
    });
    this.loop = new AgentLoop({
      ...services,
      agents: this.agents,
      checkpoint: (runId) => this.executions.checkpoint(runId),
      providerFor: (runId) => ({
        generate: async (request) => {
          try {
            this.executions.checkpoint(runId);
            return await this.usage.provider(observedProvider(services.provider), runId).generate({
              ...request,
              signal: this.executions.waitingSignal(
                runId,
                request.signal ?? new AbortController().signal,
              ),
            });
          } catch (error) {
            if (
              !this.executions.get(runId)?.controller.signal.aborted &&
              this.store.get(runId).pauseRequested
            )
              throw new RunPausedError();
            if (error instanceof ProviderError && error.limit) {
              const execution = this.executions.get(runId);
              if (execution) {
                execution.stopReason ??= error;
                execution.controller.abort();
              }
            }
            throw error;
          }
        },
      }),
      stopRun: (runId, reason) => {
        const execution = this.executions.get(runId);
        if (execution) {
          execution.stopReason ??= reason;
          execution.controller.abort();
        }
      },
    });
  }

  /** Назначает обработчик завершения для диагностики и очереди обучения. */
  onTerminal(listener: (runId: string) => Promise<void>): void {
    this.terminal = listener;
  }
  /** Подключает общий учёт владения папками, не связывая runtime с модулем проектов. */
  setWorkspaceAccess(access: WorkspaceAccess): void {
    this.access = access;
  }

  /** Возвращает внутренние операции с правом управления проектными запусками. */
  projectRuns(): ProjectRunPort {
    return {
      catalog: () => this.store.catalog(true),
      start: (input) => this.startProject(input),
      inspect: async (runId) => this.view(runId, await this.store.load(runId)),
      find: (requestKey) => this.store.catalog(true).find((run) => run.requestKey === requestKey),
      busy: (runId) => this.busy(runId),
      pause: (runId) => this.pauseProject(runId),
      resume: (runId) => this.resume(runId, this.capability),
      cancel: (runId) => this.cancel(runId, this.capability),
      sendMessage: (input) => this.sendMessage(input, this.capability),
      resolve: (input) =>
        this.resolveInvocation(
          input.runId,
          input.invocationId,
          input.result,
          input.succeeded,
          this.capability,
        ),
      subscribeSettled: (listener) => {
        this.settled.add(listener);
        return () => {
          this.settled.delete(listener);
        };
      },
    };
  }
  /** Уведомляет наблюдателей после освобождения исполнителя; их сбой не меняет журнал. */
  private notifySettled(runId: string): void {
    const entry = this.store.catalog(true).find((run) => run.id === runId);
    if (!entry?.project) return;
    const event: RunSettled = {
      runId,
      link: entry.project,
      status: this.visibleStatus(runId, entry.status),
      seq: entry.seq,
      recoveryRequired: !!this.store.recoveryError,
    };
    for (const listener of this.settled) {
      try {
        listener(event);
      } catch {
        /* Наблюдатель перечитает журнал при следующей сверке. */
      }
    }
  }
  /** Запрещает обход проектного оркестратора обычными командами задачи. */
  private assertManaged(run: RunRecord, capability?: symbol): void {
    if (run.project && capability !== this.capability)
      throw new ApplicationError(
        'PROJECT_MANAGED',
        'Этой задачей управляет проект. Откройте его для продолжения.',
      );
  }
  /** Создаёт проектный запуск и передаёт резервирование папки исполнителю. */
  private startProject(input: ProjectRunStart) {
    this.assertOpen();
    const pinned = structuredClone(input);
    return this.lifecycle.run(async () => {
      const { run, created, release } = await this.factory.createPinned(pinned, (scope) =>
        this.access.reserve(scope),
      );
      if (created) {
        try {
          this.executions.launch(run.id, release);
        } catch (error) {
          release?.();
          throw error;
        }
      }
      return { runId: run.id, sessionId: run.sessionId };
    });
  }
  /** Просит все ветки остановиться на безопасной границе и ждёт начатых эффектов. */
  private async pauseProject(runId: string): Promise<void> {
    const { done } = await this.lifecycle.run(async () => {
      const run = await this.store.load(runId);
      if (!run.project)
        throw new ApplicationError('PROJECT_MANAGED', 'Задача не принадлежит проекту.');
      const execution = this.executions.get(runId);
      if (!execution || ['completed', 'failed', 'cancelled', 'paused'].includes(run.status))
        return { done: execution?.done };
      await this.store.mutate(runId, 'run.pause_requested', {}, (state) => {
        state.pauseRequested = true;
      });
      execution.pause.abort();
      return { done: execution.done };
    });
    await done;
  }
  /** Показывает незавершённое исполнение выбранной задачи или всего сервиса, включая остановку. */
  busy(runId?: string): boolean {
    return runId ? this.executions.has(runId) : this.executions.size > 0;
  }

  /** Показывает остановленный из-за отказа записи запуск без чтения его полного состояния. */
  visibleStatus(runId: string, saved: RunStatus): RunStatus {
    return this.store.recoveryError && this.failures.has(runId) ? 'paused' : saved;
  }

  /** Дополняет сохранённую задачу фактом отказа исполнителя, не подменяя журнал на диске. */
  view(runId: string, loaded?: RunRecord): RunRecord & { recoveryRequired?: boolean } {
    const run = loaded ?? this.store.get(runId);
    if (!this.store.recoveryError) return run;
    if (this.failures.has(runId)) {
      run.status = 'paused';
      for (const agent of Object.values(run.agents))
        if (['running', 'waiting'].includes(agent.status)) agent.status = 'cancelled';
    }
    return { ...run, error: this.store.recoveryError, recoveryRequired: true };
  }

  /** Создаёт запуск или возвращает прежний результат идентичного запроса. */
  async start(input: RunInput): Promise<{ runId: string; sessionId: string }> {
    this.assertOpen();
    return this.lifecycle.run(async () => {
      const { run, created, release } = await this.factory.create(input, (scope) =>
        this.access.reserve(scope),
      );
      if (created) {
        try {
          this.executions.launch(run.id, release);
        } catch (error) {
          release?.();
          throw error;
        }
      }
      return { runId: run.id, sessionId: run.sessionId };
    });
  }

  /** Сохраняет уточнение для следующего шага текущего запуска. */
  async sendMessage(input: RunMessageInput, capability?: symbol) {
    const run = await this.store.load(input.runId);
    this.assertManaged(run, capability);
    if (run.project?.kind === 'checks')
      throw new ApplicationError(
        'PROJECT_MANAGED',
        'Детерминированная проверка не принимает уточнения модели.',
      );
    return this.inbox.send(input);
  }

  /** Отменяет всё дерево и дожидается остановки активной работы. */
  async cancel(runId: string, capability?: symbol): Promise<void> {
    const { done } = await this.lifecycle.run(async () => {
      const run = await this.store.load(runId);
      this.assertManaged(run, capability);
      const execution = this.executions.get(runId);
      // Итоговый статус записывается раньше остановки исполнителей и завершающего обработчика.
      if (['completed', 'failed', 'cancelled'].includes(run.status))
        return { done: execution?.done };
      // Флаг выставляется до abort: отказ API может прийти раньше записи отмены на диск.
      if (execution) {
        execution.cancelRequested = true;
        execution.controller.abort();
      }
      await this.store.mutate(runId, 'run.cancelled', {}, (state) => {
        state.status = 'cancelled';
        for (const agent of Object.values(state.agents))
          if (['running', 'waiting'].includes(agent.status)) agent.status = 'cancelled';
      });
      if (!execution) {
        await this.observations.stop(this.store.get(runId));
        this.notifySettled(runId);
      }
      return { done: execution?.done };
    });
    // Долгий инструмент или обучение не удерживают очередь команд остальных задач.
    await done;
  }
  /** Продолжает приостановленный запуск после разрешения неизвестных исходов. */
  async resume(runId: string, capability?: symbol): Promise<void> {
    this.assertOpen();
    return this.lifecycle.run(() => this.resumeStopped(runId, capability));
  }
  /** Сохраняет продолжение и регистрирует цикл до обработки следующей команды отмены. */
  private async resumeStopped(runId: string, capability?: symbol): Promise<void> {
    this.store.assertWritable();
    if (this.executions.has(runId)) throw new ApplicationError('TASK_BUSY', 'Run still stopping');
    const previous = await this.store.load(runId);
    this.assertManaged(previous, capability);
    if (Object.values(previous.invocations).some(requiresOutcomeReview))
      throw new ApplicationError('UNKNOWN_OUTCOME', 'Resolve unknown invocations before resuming');
    if (previous.fileChanges?.some((change) => change.status === 'restoring'))
      throw new ApplicationError(
        'UNKNOWN_OUTCOME',
        'Сначала проверьте результат прерванного восстановления файла.',
      );
    const workspace = await realpath(previous.workspace);
    if (workspace !== previous.workspace)
      throw new ApplicationError('PROJECT_CHANGED', 'Рабочая папка задачи изменилась.');
    const release = this.access.reserve({ workspace, projectId: previous.project?.projectId });
    try {
      await prepareResume(this.store, previous, this.initialConfig);
      this.agents.forgetRun(runId);
      this.executions.launch(runId, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Возвращает предел новых задач и остаток текущей порции выбранного запуска. */
  async iterationStatus(runId?: string): Promise<IterationStatus> {
    const defaultLimit = await this.iterations.defaultLimit(
      await this.factory.currentIterationLimit(),
    );
    if (!runId) return { defaultLimit };
    const loaded = await this.store.load(runId);
    return { defaultLimit, run: this.runIterationStatus(runId, loaded) };
  }
  /** Просмотр сохранённого запуска не зависит от доступности текущего файла конфигурации. */
  runIterationStatus(runId: string, loaded?: RunRecord): NonNullable<IterationStatus['run']> {
    const run = loaded ?? this.store.get(runId);
    return {
      ...iterationProgress(run),
      pausedByLimit: run.status === 'paused' && run.pauseReason === 'iterations',
      editable:
        !this.store.recoveryError &&
        !run.project &&
        !run.deletedAt &&
        run.status === 'paused' &&
        !this.executions.has(runId),
    };
  }
  /** Меняет только настройку новых задач либо предел выбранной задачи на паузе. */
  async setIterationLimit(limit: number, runId?: string, expectedLimit?: number): Promise<void> {
    this.store.assertWritable();
    validateIterationLimit(limit);
    if (!runId) {
      await this.iterations.setDefault(
        limit,
        await this.factory.currentIterationLimit(),
        expectedLimit,
      );
      return;
    }
    await this.store.mutate(runId, 'run.iteration_limit_changed', { limit }, (run) => {
      this.assertManaged(run);
      if (run.deletedAt) throw new Error('Скрытая задача доступна только для просмотра.');
      if (run.status !== 'paused' || this.executions.has(runId))
        throw new ApplicationError(
          'TASK_BUSY',
          'Предел шагов можно изменить после остановки задачи на паузе.',
        );
      assertExpectedLimit(iterationProgress(run).limit, expectedLimit);
      run.iterationLimit = limit;
    });
  }

  /** Записывает проверенный человеком исход неизвестной операции без её повторения. */
  async resolveInvocation(
    runId: string,
    invocationId: string,
    result: string,
    succeeded: boolean,
    capability?: symbol,
  ): Promise<void> {
    await this.store.mutate(runId, 'tool.human_resolved', { invocationId }, (state) => {
      this.assertManaged(state, capability);
      if (this.executions.has(runId))
        throw new ApplicationError(
          'TASK_BUSY',
          'Дождитесь полной остановки задачи перед проверкой результата.',
        );
      if (!['paused', 'cancelled', 'failed'].includes(state.status))
        throw new Error(
          'Проверить результат можно у приостановленной, остановленной или завершившейся с ошибкой задачи.',
        );
      const invocation = state.invocations[invocationId];
      if (!invocation || !requiresOutcomeReview(invocation))
        throw new Error('Invocation is not unknown');
      invocation.status = succeeded ? 'succeeded' : 'error';
      invocation.result = result;
    });
  }
  /** Дожидается завершения исполнителей выбранной задачи и передаёт ошибку сохранения. */
  async wait(runId: string): Promise<void> {
    await this.executions.get(runId)?.done;
    if (this.failures.has(runId)) throw this.failures.get(runId);
  }
  /** Отменяет принадлежащие runtime запуски и дожидается завершения остановки. */
  close(): Promise<void> {
    return (this.closing ??= this.lifecycle
      .run(async () => [...this.executions.entries()])
      .then(async (executions) => {
        // Ошибка записи отмены не означает, что инструменты уже прекратили работу.
        const results = await Promise.allSettled([
          ...executions.map(([runId]) => this.cancel(runId, this.capability)),
          ...executions.map(([, execution]) => execution.done),
        ]);
        const errors = results.filter((result) => result.status === 'rejected');
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            'Ошибка остановки задач',
          );
      })
      .finally(() => this.observations.close()));
  }
  /** Не запускает новую работу после начала закрытия сервиса. */
  private assertOpen(): void {
    if (this.closing) throw new Error('Harness закрывается. Откройте его заново для продолжения.');
  }
}
