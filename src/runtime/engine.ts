import { UsageLedger } from './usage.js';
import {
  IterationSettings,
  IterationLimitError,
  iterationProgress,
  validateIterationLimit,
  assertExpectedLimit,
  type IterationStatus,
} from './iterations.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { RunRecord } from '../sessions/types.js';
import { requiresOutcomeReview } from '../sessions/invocations.js';
import {
  assertKnownSessionOutcomes,
  missingSessionCorrections,
  sessionCorrections,
} from '../sessions/continuation.js';
import type { LearningStore } from '../learning/types.js';
import type { ModelProvider } from '../providers/types.js';
import { ProviderError } from '../providers/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PolicyService } from '../policy/service.js';
import type { ContextService } from '../context/service.js';
import type { InvocationExecutor } from './executor.js';
import { UnknownOutcomeError } from './executor.js';
import { AgentCoordinator } from '../agents/coordinator.js';
import { AgentLoop } from './agent-loop.js';
import { RunFactory, serviceFingerprint, type RunInput } from './run-factory.js';
import { abort, message, Serial } from '../shared/primitives.js';
import { RunInbox, hasPendingMessages, type RunMessageInput } from './messages.js';

class PendingMessagesError extends Error {}

export { runInputSchema, type RunInput } from './run-factory.js';

interface RuntimeServices {
  configFile: string;
  initialConfig: ConfigSnapshot;
  store: FileSessionStore;
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
  private readonly executions = new Map<
    string,
    {
      controller: AbortController;
      done: Promise<void>;
      cancelRequested: boolean;
      stopReason?: Error;
    }
  >();
  readonly usage: UsageLedger;
  private readonly iterations: IterationSettings;
  private readonly agents: AgentCoordinator;
  private readonly loop: AgentLoop;
  private readonly factory: RunFactory;
  private readonly inbox: RunInbox;
  readonly store: FileSessionStore;
  private readonly initialConfig: ConfigSnapshot;
  /** Вызывается после остановки дерева; по умолчанию завершение не запускает дополнительные действия. */
  private terminal: (runId: string) => Promise<void> = async () => undefined;

  constructor(services: RuntimeServices) {
    this.store = services.store;
    this.inbox = new RunInbox(services.store);
    this.usage = new UsageLedger(services.store);
    this.iterations = new IterationSettings(services.store.directory);
    this.initialConfig = services.initialConfig;
    this.factory = new RunFactory(
      services.configFile,
      services.initialConfig,
      services.store,
      services.learning,
      this.iterations,
    );
    this.agents = new AgentCoordinator(services.store, (runId, agentId, signal) =>
      this.loop.run(runId, agentId, signal),
    );
    this.loop = new AgentLoop({
      ...services,
      agents: this.agents,
      providerFor: (runId) => ({
        generate: async (request) => {
          try {
            return await this.usage.provider(services.provider, runId).generate(request);
          } catch (error) {
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
  /** Показывает незавершённое исполнение выбранной задачи или всего сервиса, включая остановку. */
  busy(runId?: string): boolean {
    return runId ? this.executions.has(runId) : this.executions.size > 0;
  }

  /** Дополняет сохранённую задачу фактом отказа исполнителя, не подменяя журнал на диске. */
  view(runId: string): RunRecord & { recoveryRequired?: boolean } {
    const run = this.store.get(runId);
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
      const { run, created } = await this.factory.create(input);
      if (created) this.launch(run.id);
      return { runId: run.id, sessionId: run.sessionId };
    });
  }

  /** Сохраняет уточнение для следующего шага текущего запуска. */
  sendMessage(input: RunMessageInput) {
    return this.inbox.send(input);
  }

  /** Запускает корень и координирует финализацию, паузы и остановку дочерних веток. */
  private launch(runId: string): void {
    if (this.executions.has(runId)) throw new Error('Run already executing');
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          while (true) {
            await this.loop.run(runId, this.store.get(runId).rootAgentId, controller.signal);
            abort(controller.signal);
            try {
              await this.store.mutate(runId, 'run.completed', {}, (run) => {
                abort(controller.signal);
                // Приём сообщения и финализация используют один журнал: принятое уточнение не теряется.
                if (hasPendingMessages(run)) throw new PendingMessagesError();
                run.status = 'completed';
                run.result = run.agents[run.rootAgentId]!.result;
              });
              break;
            } catch (error) {
              if (!(error instanceof PendingMessagesError)) throw error;
            }
          }
        } catch (caught) {
          const error = this.executions.get(runId)?.stopReason ?? caught;
          const providerPause = error instanceof ProviderError ? error.limit : undefined;
          const paused =
            error instanceof UnknownOutcomeError ||
            error instanceof IterationLimitError ||
            !!providerPause;
          controller.abort();
          if (
            !this.executions.get(runId)?.cancelRequested &&
            this.store.get(runId).status !== 'cancelled'
          )
            await this.store.mutate(
              runId,
              paused ? 'run.paused' : 'run.failed',
              { error: message(error) },
              (run) => {
                run.status = paused ? 'paused' : 'failed';
                run.error = message(error);
                if (error instanceof IterationLimitError) run.pauseReason = 'iterations';
                else if (providerPause) run.pauseReason = 'provider';
                else delete run.pauseReason;
                if (providerPause) run.providerPause = providerPause;
                else delete run.providerPause;
                if (run.status === 'failed') run.agents[run.rootAgentId]!.status = 'failed';
              },
            );
        } finally {
          await this.agents.waitForRun(runId);
          await this.store.recoverInterrupted(runId);
          if (['completed', 'failed'].includes(this.store.get(runId).status)) {
            try {
              await this.terminal(runId);
            } catch {
              /* Сбой обучения не меняет результат пользовательской задачи. */
            }
          }
        }
      })
      .catch((error: unknown) => {
        // Сохранённая пауза уже защищена проверкой неизвестных операций при продолжении.
        // Полностью блокируем запись, только если журнал всё ещё обещает активное исполнение.
        if (['running', 'awaiting_approval'].includes(this.store.get(runId).status)) {
          this.failures.set(runId, error);
          this.store.requireRecovery(error);
          for (const execution of this.executions.values()) execution.controller.abort();
        }
        throw error;
      })
      .finally(() => {
        this.agents.forgetRun(runId);
        this.executions.delete(runId);
      });
    this.executions.set(runId, { controller, done, cancelRequested: false });
    // CLI может только опрашивать статус. Отказ диска не должен стать необработанным rejection;
    // явный wait по-прежнему ожидает исходный promise и получает ошибку.
    void done.catch(() => undefined);
  }
  /** Отменяет всё дерево и дожидается остановки активной работы. */
  async cancel(runId: string): Promise<void> {
    const { done } = await this.lifecycle.run(async () => {
      const run = this.store.get(runId);
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
      return { done: execution?.done };
    });
    // Долгий инструмент или обучение не удерживают очередь команд остальных задач.
    await done;
  }
  /** Продолжает приостановленный запуск после разрешения неизвестных исходов. */
  async resume(runId: string): Promise<void> {
    this.assertOpen();
    return this.lifecycle.run(() => this.resumeStopped(runId));
  }
  /** Сохраняет продолжение и регистрирует цикл до обработки следующей команды отмены. */
  private async resumeStopped(runId: string): Promise<void> {
    this.store.assertWritable();
    if (this.executions.has(runId)) throw new Error('Run still stopping');
    if (
      serviceFingerprint(this.store.get(runId).config.value) !==
      serviceFingerprint(this.initialConfig.value)
    ) {
      throw new Error(
        'Resume requires the original MCP, concurrency and learning service settings',
      );
    }
    await this.store.mutate(runId, 'run.resumed', {}, (state) => {
      if (state.status !== 'paused') throw new Error('Only paused runs can be resumed');
      if (Object.values(state.invocations).some(requiresOutcomeReview))
        throw new Error('Resolve unknown invocations before resuming');
      if (state.fileChanges?.some((change) => change.status === 'restoring'))
        throw new Error('Сначала проверьте результат прерванного восстановления файла.');
      const sessionRuns = this.store.list(true).filter((run) => run.sessionId === state.sessionId);
      assertKnownSessionOutcomes(sessionRuns);
      if (state.providerPause?.retryAt && Date.parse(state.providerPause.retryAt) > Date.now())
        throw new Error(
          'Провайдер просит подождать до ' +
            state.providerPause.retryAt +
            '. Затем продолжите задачу.',
        );
      state.status = 'running';
      delete state.providerPause;
      state.iterationLimit ??= state.config.value.limits.turns;
      state.iterationStart = state.turns;
      delete state.pauseReason;
      delete state.error;
      const corrections = sessionCorrections(this.store, sessionRuns);
      for (const agent of Object.values(state.agents))
        if (agent.status !== 'completed' && agent.status !== 'failed') {
          let parent = agent.parentId ? state.agents[agent.parentId] : undefined;
          while (parent && !['completed', 'failed'].includes(parent.status))
            parent = parent.parentId ? state.agents[parent.parentId] : undefined;
          if (parent) {
            // Завершённая ветка не запустит потомков повторно через agents.await.
            agent.status = 'cancelled';
            continue;
          }
          // Сводка дополняется отдельно: pending-вызовы ещё не имеют сообщений с результатами.
          const missing = missingSessionCorrections(corrections, agent);
          if (missing.length)
            agent.summary = [agent.summary, ...missing.map((item) => item.content)]
              .filter(Boolean)
              .join('\n\n');
          agent.status = 'running';
          delete agent.error;
        }
    });
    this.agents.forgetRun(runId);
    this.launch(runId);
  }
  /** Возвращает предел новых задач и остаток текущей порции выбранного запуска. */
  async iterationStatus(runId?: string): Promise<IterationStatus> {
    const defaultLimit = await this.iterations.defaultLimit(
      await this.factory.currentIterationLimit(),
    );
    if (!runId) return { defaultLimit };
    return { defaultLimit, run: this.runIterationStatus(runId) };
  }
  /** Просмотр сохранённого запуска не зависит от доступности текущего файла конфигурации. */
  runIterationStatus(runId: string): NonNullable<IterationStatus['run']> {
    const run = this.store.get(runId);
    return {
      ...iterationProgress(run),
      pausedByLimit: run.status === 'paused' && run.pauseReason === 'iterations',
      editable:
        !this.store.recoveryError &&
        !run.deletedAt &&
        run.status === 'paused' &&
        !this.executions.has(runId),
    };
  }
  /** Меняет только настройку новых задач либо предел выбранной задачи на паузе. */
  async setIterationLimit(limit: number, runId?: string, expectedLimit?: number): Promise<void> {
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
      if (run.deletedAt) throw new Error('Скрытая задача доступна только для просмотра.');
      if (run.status !== 'paused' || this.executions.has(runId))
        throw new Error('Предел шагов можно изменить после остановки задачи на паузе.');
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
  ): Promise<void> {
    await this.store.mutate(runId, 'tool.human_resolved', { invocationId }, (state) => {
      if (this.executions.has(runId))
        throw new Error('Дождитесь полной остановки задачи перед проверкой результата.');
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
          ...executions.map(([runId]) => this.cancel(runId)),
          ...executions.map(([, execution]) => execution.done),
        ]);
        const errors = results.filter((result) => result.status === 'rejected');
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            'Ошибка остановки задач',
          );
      }));
  }
  /** Не запускает новую работу после начала закрытия сервиса. */
  private assertOpen(): void {
    if (this.closing) throw new Error('Harness закрывается. Откройте его заново для продолжения.');
  }
}
