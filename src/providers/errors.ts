export interface ProviderLimit {
  kind: 'rate_limit' | 'quota';
  retryAt?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly contextOverflow = false,
    readonly limit?: ProviderLimit,
  ) {
    super(message);
  }
}
