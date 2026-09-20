import type { ObservationSpan, ObservedUsage } from '../insights/ports.js';
import type { Semaphore } from '../shared/primitives.js';
import type { ModelOutput, ModelRequest } from './types.js';

/** Измеряет только ожидание места: вложенная очередь начинается после закрытия внешней. */
export async function observeModelQueue(
  request: ModelRequest,
  limiter: Semaphore,
  work: () => Promise<ModelOutput>,
): Promise<ModelOutput> {
  let queued = request.observation?.begin('model.queue');
  try {
    return await limiter.use(() => {
      queued?.end();
      queued = undefined;
      return work();
    }, request.signal);
  } finally {
    queued?.end(request.signal?.aborted ? 'cancelled' : 'failed');
  }
}

/** Сохраняет первый фрагмент и итоговый расход одной попытки, включая неуспешную. */
export class ModelAttemptObservation {
  private readonly requestSpan: ObservationSpan | undefined;
  private firstSpan: ObservationSpan | undefined;
  private tokens: ObservedUsage = { input: null, output: null, source: 'unavailable' };
  private ended = false;

  constructor(
    private readonly request: ModelRequest,
    private readonly attempt: number,
  ) {
    this.requestSpan = request.observation?.begin('model.request', { attempt });
    this.firstSpan = request.observation?.begin('model.first_output', { attempt });
  }

  /** Закрывает задержку первого опубликованного текста, пояснения или вызова инструмента. */
  firstOutput(): void {
    this.firstSpan?.end();
    this.firstSpan = undefined;
  }

  /** Заменяет промежуточный расход; накопительные уведомления не суммируются. */
  usage(usage: ObservedUsage): void {
    this.tokens = usage;
  }

  /** Завершает измерение один раз, даже если дальнейшая очистка вызова завершилась ошибкой. */
  end(outcome: 'completed' | 'failed' | 'cancelled'): void {
    if (this.ended) return;
    this.ended = true;
    this.firstSpan?.end('interrupted');
    this.firstSpan = undefined;
    this.requestSpan?.end(outcome);
    this.request.observation?.usage(this.tokens, { attempt: this.attempt });
  }
}

/** Отделяет отсутствующие и некорректные значения от подтверждённого нулевого расхода. */
export function observedTokens(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}
