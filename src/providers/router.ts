import { Semaphore } from '../shared/primitives.js';
import { SdkModelProvider } from './sdk-provider.js';
import { CodexModelProvider } from './codex/provider.js';
import type { ModelProvider, ModelRequest, ModelOutput } from './types.js';

/** Общая очередь ограничивает суммарный параллелизм всех подключений. */
export class ProviderRouter implements ModelProvider {
  private readonly limiter: Semaphore;
  private readonly sdk: SdkModelProvider;
  private readonly codex = new CodexModelProvider();
  constructor(concurrency: number) {
    this.limiter = new Semaphore(concurrency);
    this.sdk = new SdkModelProvider(concurrency);
  }
  /** Выбирает SDK или Codex и соблюдает общий предел одновременных запросов. */
  generate(request: ModelRequest): Promise<ModelOutput> {
    return this.limiter.use(
      () => (request.profile.provider === 'codex' ? this.codex : this.sdk).generate(request),
      request.signal,
    );
  }
}
