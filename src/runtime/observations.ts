import { randomUUID } from 'node:crypto';
import type {
  ExecutionObserver,
  ExecutionObservation,
  ObservationSpan,
} from '../insights/ports.js';
import { noObservation } from '../insights/ports.js';
import type { AgentState, RunRecord } from '../sessions/types.js';
import type { ModelProvider } from '../providers/types.js';

/** Роль и профиль берутся из неизменной конфигурации конкретного запуска. */
export function observeAgent(
  observer: ExecutionObserver | undefined,
  run: RunRecord,
  agent: AgentState,
  requestId?: string,
): ExecutionObservation {
  return (
    observer?.scope({
      runId: run.id,
      agentId: agent.id,
      role: agent.role,
      profile: run.config.value.roles[agent.role]?.modelProfile ?? run.profile,
      requestId,
    }) ?? noObservation
  );
}

/** Измеряет внешний адаптер без собственных фаз, сохраняя совместимость провайдеров. */
export function observedProvider(provider: ModelProvider): ModelProvider {
  if (provider.observesRequests) return provider;
  return {
    observesRequests: true,
    async generate(request) {
      const observation = request.observation ?? noObservation;
      const operation = observation.begin('model.request', { attempt: 1 });
      const first = observation.begin('model.first_output', { attempt: 1 });
      let seen = false;
      const received = (): void => {
        if (!seen) {
          seen = true;
          first.end();
        }
      };
      try {
        const output = await provider.generate({
          ...request,
          observation: undefined,
          onProgress: (event) => {
            if (event.type !== 'retry') received();
            request.onProgress?.(event);
          },
        });
        if (output.text || output.calls.length || output.reasoning) received();
        observation.usage(
          {
            input: output.usageSource ? output.usage.input : null,
            output: output.usageSource ? output.usage.output : null,
            source: output.usageSource ?? 'unavailable',
          },
          { attempt: 1 },
        );
        operation.end();
        return output;
      } catch (error) {
        observation.usage({ input: null, output: null, source: 'unavailable' }, { attempt: 1 });
        operation.end(request.signal?.aborted ? 'cancelled' : 'failed');
        throw error;
      } finally {
        if (!seen) first.end('interrupted');
      }
    },
  };
}

/** Пауза измеряется только в живом процессе; восстановление не приписывает простой модели. */
export class RunObservations {
  private readonly pauses = new Map<string, ObservationSpan>();
  constructor(private readonly observer?: ExecutionObserver) {}
  start(run: RunRecord): ObservationSpan {
    this.pauses.get(run.id)?.end();
    this.pauses.delete(run.id);
    return observeAgent(this.observer, run, run.agents[run.rootAgentId]!).begin('run');
  }
  async stop(run: RunRecord): Promise<void> {
    if (run.status === 'paused') {
      if (!this.pauses.has(run.id))
        this.pauses.set(
          run.id,
          observeAgent(this.observer, run, run.agents[run.rootAgentId]!).begin('pause'),
        );
    } else {
      this.pauses.get(run.id)?.end(run.status === 'cancelled' ? 'cancelled' : 'completed');
      this.pauses.delete(run.id);
    }
    await this.observer?.flush?.();
    this.observer?.release?.(run.id);
  }
  /** Закрывает оставшиеся паузы до остановки наблюдателя, не добавляя время выключенного сервиса. */
  async close(): Promise<void> {
    for (const pause of this.pauses.values()) pause.end('interrupted');
    this.pauses.clear();
    await this.observer?.flush?.();
  }
  /** Удаляемая задача не должна получить позднее завершение интервала. */
  forget(runIds: string[]): void {
    for (const id of runIds) this.pauses.delete(id);
  }
}

/** Создаёт идентификатор отдельного запроса сжатия, не меняя поток обычного ответа. */
export const observationRequestId = (): string => randomUUID();
