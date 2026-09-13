import { abort } from '../shared/primitives.js';
interface Job {
  effect: 'read' | 'write';
  work: () => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  detach(): void;
}

/** Общая очередь чтения и записи; запись не пересекается с чтениями. */
export class ToolScheduler {
  private readonly queue: Job[] = [];
  private readers = 0;
  private writer = false;
  constructor(private readonly readLimit: number) {}
  /** Ставит операцию в общую очередь; отмена снимает ещё не запущенное задание. */
  schedule<T>(effect: 'read' | 'write', work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = (): void => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        job.detach();
        reject(new Error('CANCELLED'));
        this.pump();
      };
      const job: Job = {
        effect,
        work: async () => {
          abort(signal);
          return work();
        },
        resolve: (value) => resolve(value as T),
        reject,
        detach: () => signal?.removeEventListener('abort', cancel),
      };
      this.queue.push(job);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      this.pump();
    });
  }
  /** Запускает допустимую группу чтений либо одну запись, сохраняя порядок барьеров. */
  private pump(): void {
    if (this.writer) return;
    while (this.queue.length) {
      const job = this.queue[0]!;
      if (job.effect === 'write' && this.readers > 0) return;
      if (job.effect === 'read' && this.readers >= this.readLimit) return;
      this.queue.shift();
      job.detach();
      if (job.effect === 'write') this.writer = true;
      else this.readers++;
      void job
        .work()
        .then(job.resolve, job.reject)
        .finally(() => {
          if (job.effect === 'write') this.writer = false;
          else this.readers--;
          this.pump();
        });
      if (this.writer) return;
    }
  }
}
