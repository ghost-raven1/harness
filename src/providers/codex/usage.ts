type Tokens = { inputTokens: number; outputTokens: number };

/** Сводит расход Responses и накопительный снимок потока без повторного учёта токенов. */
export class CodexUsage {
  private readonly responses = new Map<string | undefined, Tokens>();
  private raw: Tokens = { inputTokens: 0, outputTokens: 0 };
  private cumulative: Tokens = { inputTokens: 0, outputTokens: 0 };

  /** Один responseId учитывается один раз; уведомление без ID заменяет предыдущее без ID. */
  response(usage: Tokens, responseId?: string): void {
    const previous = this.responses.get(responseId) ?? { inputTokens: 0, outputTokens: 0 };
    const next = this.maximum(previous, usage);
    this.raw.inputTokens += next.inputTokens - previous.inputTokens;
    this.raw.outputTokens += next.outputTokens - previous.outputTokens;
    this.responses.set(responseId, next);
  }

  /** Сохраняет последний достигнутый итог: повтор и задержанное уведомление его не увеличивают. */
  total(usage: Tokens): void {
    this.cumulative = this.maximum(this.cumulative, usage);
  }

  /** Возвращает единый расход эфемерного потока вместо суммы двух каналов уведомлений. */
  current(): { input: number; output: number } {
    const usage = this.maximum(this.raw, this.cumulative);
    return { input: usage.inputTokens, output: usage.outputTokens };
  }

  /** Выбирает большую подтверждённую величину по каждой стороне расхода. */
  private maximum(left: Tokens, right: Tokens): Tokens {
    return {
      inputTokens: Math.max(left.inputTokens, right.inputTokens),
      outputTokens: Math.max(left.outputTokens, right.outputTokens),
    };
  }
}
