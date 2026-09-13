import type { LearningStore } from './types.js';
import type { ModelProvider, ModelRequest, ModelOutput } from '../providers/types.js';
export class LearningYield extends Error {}

/** Учитывает расход обучения и уступает модели пользовательским задачам. */
export class LearningBudget {
  private readonly controller = new AbortController();
  constructor(
    private readonly store: LearningStore,
    private readonly provider: ModelProvider,
    private readonly busy: () => boolean,
  ) {}
  async generate(request: ModelRequest): Promise<ModelOutput> {
    const amount =
      Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools })) +
      request.profile.outputTokens +
      256;
    await this.store.update((state) => {
      if (state.paused || this.busy())
        throw new LearningYield('Learning deferred while paused or user tasks are running');
      const date = new Date().toISOString().slice(0, 10);
      if (state.daily.date !== date) state.daily = { date, tokens: 0 };
      state.daily.tokens += amount;
    });
    // Обучение не выполняет автоматические платные повторы запросов.
    return this.provider.generate({
      ...request,
      signal: this.controller.signal,
      profile: { ...request.profile, retries: 0 },
    });
  }
  close(): void {
    this.controller.abort();
  }
}
