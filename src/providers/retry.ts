import { setTimeout as delay } from 'node:timers/promises';
import { abort } from '../shared/primitives.js';
import { ProviderError } from './errors.js';
import type { ModelRequest, ModelOutput } from './types.js';

/** Ограничивает повторы и суммарное ожидание; длинный Retry-After остаётся причиной паузы. */
export async function retryModelRequest(
  request: ModelRequest,
  once: () => Promise<ModelOutput>,
): Promise<ModelOutput> {
  let waited = 0;
  const waitBudget = Math.min(request.profile.timeoutMs, 30000);
  for (let attempt = 0; ; attempt++) {
    abort(request.signal);
    try {
      return await once();
    } catch (error) {
      if (request.signal?.aborted) throw new ProviderError('Запрос к модели отменён.');
      if (
        !(error instanceof ProviderError) ||
        !error.retryable ||
        attempt >= request.profile.retries
      )
        throw error;
      const retryAt = error.limit?.retryAt ? Date.parse(error.limit.retryAt) : undefined;
      const wait = Math.max(250 * 2 ** attempt, retryAt === undefined ? 0 : retryAt - Date.now());
      if (waited + wait > waitBudget) throw error;
      request.onProgress?.({ type: 'retry', attempt: attempt + 2 });
      await delay(wait, undefined, { signal: request.signal });
      waited += wait;
    }
  }
}
