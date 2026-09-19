import type { SessionStore } from '../sessions/ports.js';
import type { AgentCoordinator } from '../agents/coordinator.js';
import { ApplicationError } from '../shared/application-error.js';
import { abort, message } from '../shared/primitives.js';
import { ProviderError } from '../providers/errors.js';
import { UnknownOutcomeError } from './executor.js';
import { IterationLimitError } from './iterations.js';
import { hasPendingMessages } from './messages.js';
import { RunPausedError } from '../shared/run-pause.js';

class PendingMessagesError extends Error {}
interface Execution {
  controller: AbortController;
  pause: AbortController;
  done: Promise<void>;
  cancelRequested: boolean;
  stopReason?: Error;
}
interface ExecutionServices {
  store: SessionStore;
  agents: AgentCoordinator;
  failures: Map<string, unknown>;
  executeRoot(runId: string, signal: AbortSignal): Promise<void>;
  terminal(runId: string): Promise<void>;
  settled(runId: string): void;
}
/** Владеет исполнителями дерева и сообщает об остановке только после всех финализаторов. */
export class RuntimeExecutions extends Map<string, Execution> {
  constructor(private readonly services: ExecutionServices) {
    super();
  }
  /** Проверяет мягкую паузу без отмены сигнала уже начатой записи. */
  checkpoint(runId: string): void {
    if (this.get(runId)?.pause.signal.aborted || this.services.store.get(runId).pauseRequested)
      throw new RunPausedError();
  }
  /** Ожидание модели, очереди и разрешения можно прервать раньше побочного эффекта. */
  waitingSignal(runId: string, signal: AbortSignal): AbortSignal {
    const pause = this.get(runId)?.pause.signal;
    return pause ? AbortSignal.any([signal, pause]) : signal;
  }
  /** Исполняет дерево до завершения, ошибки или паузы и освобождает резервирование папки. */
  launch(runId: string, release: () => void = () => undefined): void {
    if (this.has(runId)) throw new ApplicationError('TASK_BUSY', 'Run already executing');
    this.services.store.pin(runId);
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          while (true) {
            await this.services.executeRoot(runId, controller.signal);
            abort(controller.signal);
            this.checkpoint(runId);
            try {
              await this.services.store.mutate(runId, 'run.completed', {}, (run) => {
                abort(controller.signal);
                this.checkpoint(runId);
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
          const error = this.get(runId)?.stopReason ?? caught;
          const providerPause = error instanceof ProviderError ? error.limit : undefined;
          const paused =
            error instanceof RunPausedError ||
            error instanceof UnknownOutcomeError ||
            error instanceof IterationLimitError ||
            !!providerPause;
          if (!(error instanceof RunPausedError)) controller.abort();
          if (
            !this.get(runId)?.cancelRequested &&
            this.services.store.get(runId).status !== 'cancelled'
          )
            await this.services.store.mutate(
              runId,
              paused ? 'run.paused' : 'run.failed',
              { error: message(error) },
              (run) => {
                run.status = paused ? 'paused' : 'failed';
                run.error = message(error);
                if (error instanceof RunPausedError) run.pauseReason = 'project';
                else if (error instanceof IterationLimitError) run.pauseReason = 'iterations';
                else if (providerPause) run.pauseReason = 'provider';
                else delete run.pauseReason;
                if (providerPause) run.providerPause = providerPause;
                else delete run.providerPause;
                if (run.status === 'failed') run.agents[run.rootAgentId]!.status = 'failed';
              },
            );
        } finally {
          await this.services.agents.waitForRun(runId);
          await this.services.store.recoverInterrupted(runId);
          if (['completed', 'failed'].includes(this.services.store.get(runId).status)) {
            try {
              await this.services.terminal(runId);
            } catch {
              /* Сбой обучения не меняет результат пользовательской задачи. */
            }
          }
        }
      })
      .catch((error: unknown) => {
        // Сохранённая пауза уже защищена проверкой неизвестных операций при продолжении.
        // Полностью блокируем запись, только если журнал всё ещё обещает активное исполнение.
        if (['running', 'awaiting_approval'].includes(this.services.store.get(runId).status)) {
          this.services.failures.set(runId, error);
          this.services.store.requireRecovery(error);
          for (const execution of this.values()) execution.controller.abort();
        }
        throw error;
      })
      .finally(() => {
        this.services.agents.forgetRun(runId);
        this.delete(runId);
        this.services.store.unpin(runId);
        release();
        this.services.settled(runId);
      });
    this.set(runId, { controller, pause: new AbortController(), done, cancelRequested: false });
    // CLI может только опрашивать статус. Отказ диска не должен стать необработанным rejection;
    // явный wait по-прежнему ожидает исходный promise и получает ошибку.
    void done.catch(() => undefined);
  }
}
