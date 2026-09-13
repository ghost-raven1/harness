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
import { requiresOutcomeReview } from '../sessions/invocations.js';
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
import { abort, message } from '../shared/primitives.js';

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
  readonly store: FileSessionStore;
  private readonly initialConfig: ConfigSnapshot;
  private terminal: (runId: string) => Promise<void> = async () => undefined;

  constructor(services: RuntimeServices) {
    this.store = services.store;
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

  onTerminal(listener: (runId: string) => Promise<void>): void {
    this.terminal = listener;
  }
  busy(): boolean {
    return this.executions.size > 0;
  }

  /** Создаёт запуск или возвращает прежний результат идентичного запроса. */
  async start(input: RunInput): Promise<{ runId: string; sessionId: string }> {
    const { run, created } = await this.factory.create(input);
    if (created) this.launch(run.id);
    return { runId: run.id, sessionId: run.sessionId };
  }

  private launch(runId: string): void {
    if (this.executions.has(runId)) throw new Error('Run already executing');
    const controller = new AbortController();
    const done = Promise.resolve().then(async () => {
      try {
        await this.loop.run(runId, this.store.get(runId).rootAgentId, controller.signal);
        const root = this.store.get(runId);
        abort(controller.signal);
        await this.store.mutate(runId, 'run.completed', {}, (run) => {
          run.status = 'completed';
          run.result = root.agents[root.rootAgentId]!.result;
        });
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
        try {
          await this.agents.waitForRun(runId);
          await this.store.recoverInterrupted(runId);
          if (['completed', 'failed'].includes(this.store.get(runId).status)) {
            try {
              await this.terminal(runId);
            } catch {
              /* Сбой обучения не меняет результат пользовательской задачи. */
            }
          }
        } finally {
          this.agents.forgetRun(runId);
          this.executions.delete(runId);
        }
      }
    });
    this.executions.set(runId, { controller, done, cancelRequested: false });
    // CLI может только опрашивать статус. Отказ диска не должен стать необработанным rejection;
    // явный wait по-прежнему ожидает исходный promise и получает ошибку.
    void done.catch(() => undefined);
  }
  /** Отменяет всё дерево и дожидается остановки активной работы. */
  async cancel(runId: string): Promise<void> {
    const run = this.store.get(runId);
    const execution = this.executions.get(runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      // Итоговый статус записывается раньше остановки исполнителей и завершающего обработчика.
      await execution?.done;
      return;
    }
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
    await execution?.done;
  }
  /** Продолжает приостановленный запуск после разрешения неизвестных исходов. */
  async resume(runId: string): Promise<void> {
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
      for (const agent of Object.values(state.agents))
        if (agent.status !== 'completed' && agent.status !== 'failed') {
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
      editable: !run.deletedAt && run.status === 'paused' && !this.executions.has(runId),
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

  async resolveInvocation(
    runId: string,
    invocationId: string,
    result: string,
    succeeded: boolean,
  ): Promise<void> {
    await this.store.mutate(runId, 'tool.human_resolved', { invocationId }, (state) => {
      if (!['paused', 'cancelled', 'failed'].includes(state.status))
        throw new Error(
          'Проверить результат можно у приостановленной, остановленной или завершившейся с ошибкой задачи.',
        );
      const invocation = state.invocations[invocationId];
      if (!invocation || invocation.status !== 'unknown')
        throw new Error('Invocation is not unknown');
      invocation.status = succeeded ? 'succeeded' : 'error';
      invocation.result = result;
    });
  }
  async wait(runId: string): Promise<void> {
    await this.executions.get(runId)?.done;
  }
  async close(): Promise<void> {
    await Promise.all([...this.executions.keys()].map((runId) => this.cancel(runId)));
  }
}
