import { createHash, randomUUID } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
export const id = (): string => randomUUID();
export const clone = <T>(value: T): T => structuredClone(value);
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
export function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('CANCELLED');
}

/** Ограничивает параллелизм с сохранением очереди; отменённая работа не выполняется. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async use<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    abort(signal);
    await new Promise<void>((resolve, reject) => {
      const cancel = (): void => {
        const index = this.queue.indexOf(enter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error('CANCELLED'));
      };
      const enter = (): void => {
        signal?.removeEventListener('abort', cancel);
        this.active++;
        resolve();
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (this.active < this.limit) enter();
      else this.queue.push(enter);
    });
    try {
      abort(signal);
      return await work();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Объединяет отмену и тайм-аут с явным удалением обработчиков. */
export function deadline(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; close(): void } {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  const timer = setTimeout(cancel, ms);
  parent?.addEventListener('abort', cancel, { once: true });
  if (parent?.aborted) cancel();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
    },
  };
}
