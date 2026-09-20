import { Semaphore } from '../shared/primitives.js';
import { SdkModelProvider } from './sdk-provider.js';
import { CodexModelProvider } from './codex/provider.js';
import type { ModelProvider, ModelRequest, ModelOutput } from './types.js';
import { observeModelQueue } from './observation.js';

/** Общая очередь ограничивает суммарный параллелизм всех подключений. */
export class ProviderRouter implements ModelProvider {
  readonly observesRequests = true;
  private readonly limiter: Semaphore;
  private readonly sdk: SdkModelProvider;
  private readonly codex = new CodexModelProvider();
  constructor(concurrency: number) {
    this.limiter = new Semaphore(concurrency);
    this.sdk = new SdkModelProvider(concurrency);
  }
  /** Выбирает SDK или Codex и соблюдает общий предел одновременных запросов. */
  generate(request: ModelRequest): Promise<ModelOutput> {
    return observeModelQueue(request, this.limiter, () =>
      (request.profile.provider === 'codex' ? this.codex : this.sdk).generate(request),
    );
  }
}
