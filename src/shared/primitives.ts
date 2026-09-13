import { createHash, randomUUID } from 'node:crypto';

export type JsonObject = Record<string, unknown>;
/** Создаёт независимый идентификатор записи или запроса. */
export const id = (): string => randomUUID();
/** Возвращает глубокую копию состояния, исключая изменения хранилища через внешние ссылки. */
export const clone = <T>(value: T): T => structuredClone(value);
/** Извлекает текст ошибки, включая значения, выброшенные вне Error. */
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
/** Сериализует значения с устойчивым порядком ключей для сравнения и хеширования. */
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
/** Вычисляет SHA-256 устойчивого представления для привязки запросов к содержимому. */
export const hash = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');
/** Прерывает текущий шаг, если внешний сигнал уже отменён. */
export function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('CANCELLED');
}

/** Ограничивает параллелизм с сохранением очереди; отменённая работа не выполняется. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  /** Ожидает свободное место и освобождает его после успеха, ошибки или отмены. */
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
  /** Ставит работу после предыдущей, сохраняя работоспособность очереди при ошибках. */
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
    /** Удаляет таймер и связь с родительским сигналом после окончания операции. */
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
    },
  };
}
