import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export interface DiffResult {
  state: 'available' | 'limited';
  text: string;
  reason?: string;
}
interface DiffJob {
  projectId: string;
  key: string;
  path: string;
  load: () => Promise<{ before: string; after: string }>;
  resolve: (result: DiffResult) => void;
  reject: (error: unknown) => void;
  generation: number;
}
const maximumBytes = 16 * 1024 * 1024;
const maximumQueue = 8;
const limited = (reason: string): DiffResult => ({ state: 'limited', text: '', reason });

/** Один worker, короткая очередь и общий LRU не позволяют сравнениям занять память сервиса. */
export class ProjectDiffWorker {
  private worker?: Worker;
  private active?: DiffJob;
  private readonly queue: DiffJob[] = [];
  private readonly pending = new Map<string, Promise<DiffResult>>();
  private readonly cache = new Map<
    string,
    { projectId: string; result: DiffResult; bytes: number }
  >();
  private bytes = 0;
  private generation = 0;
  private sequence = 0;
  private closed = false;

  /** Вычисляет одинаковый запрос один раз; содержимое загружается только перед исполнением. */
  compute(
    projectId: string,
    key: string,
    path: string,
    load: DiffJob['load'],
  ): Promise<DiffResult> {
    if (this.closed) return Promise.resolve(limited('Сервис сравнения остановлен.'));
    const identity = projectId + ':' + key;
    const running = this.pending.get(identity);
    if (running) return running;
    if (this.queue.length + Number(Boolean(this.active)) >= maximumQueue)
      return Promise.resolve(limited('Очередь сравнения занята. Повторите просмотр позже.'));
    const promise = new Promise<DiffResult>((resolve, reject) => {
      this.queue.push({
        projectId,
        key: identity,
        path,
        load,
        resolve,
        reject,
        generation: this.generation,
      });
    });
    this.pending.set(identity, promise);
    void this.pump();
    return promise;
  }

  /** После удаления проекта ожидающие и завершённые сравнения теряют доступ к его данным. */
  forget(projectId?: string): void {
    this.generation++;
    for (const [key, entry] of this.cache) {
      if (projectId && entry.projectId !== projectId) continue;
      this.cache.delete(key);
      this.bytes -= entry.bytes;
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]!;
      if (projectId && job.projectId !== projectId) continue;
      this.queue.splice(index, 1);
      this.pending.delete(job.key);
      job.resolve(limited('Сохранённое сравнение удалено.'));
    }
    if (this.active && (!projectId || this.active.projectId === projectId)) {
      this.active.generation = -1;
      void this.worker?.terminate();
      this.worker = undefined;
    }
  }

  /** Завершение сервиса освобождает worker и не оставляет ожидающие запросы. */
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.forget();
    await worker?.terminate();
    this.worker = undefined;
  }

  /** Диагностика раскрывает только размеры, без исходного кода. */
  stats() {
    return {
      bytes: this.bytes,
      maximumBytes,
      entries: this.cache.size,
      pending: this.pending.size,
      queued: this.queue.length,
    };
  }

  /** Единственный обработчик очереди загружает не больше одной пары исходников одновременно. */
  private async pump(): Promise<void> {
    if (this.active || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try {
      const input = await job.load();
      const cached = this.cache.get(job.key);
      if (cached) {
        this.cache.delete(job.key);
        this.cache.set(job.key, cached);
      }
      const result =
        job.generation < 0 || this.closed
          ? limited('Сохранённое сравнение удалено.')
          : (cached?.result ?? (await this.execute(job.path, input)));
      if (job.generation === this.generation && !this.closed) this.remember(job, result);
      job.resolve(job.generation < 0 ? limited('Сохранённое сравнение удалено.') : result);
    } catch (error) {
      job.reject(error);
    } finally {
      this.pending.delete(job.key);
      this.active = undefined;
      void this.pump();
    }
  }

  /** Секунда относится к вычислению; загрузка потока имеет отдельный предел запуска. */
  private async execute(
    path: string,
    input: { before: string; after: string },
  ): Promise<DiffResult> {
    let worker: Worker;
    try {
      worker = this.worker ?? (await this.startWorker());
    } catch {
      return limited('Не удалось запустить сравнение. Откройте «До» или «После».');
    }
    if (this.closed || this.active?.generation === -1)
      return limited('Сохранённое сравнение удалено.');
    const id = ++this.sequence;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: DiffResult, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.off('message', message);
        worker.off('error', failure);
        worker.off('exit', failure);
        if (terminate) {
          if (this.worker === worker) this.worker = undefined;
          void worker.terminate().then(
            () => resolve(result),
            () => resolve(result),
          );
        } else resolve(result);
      };
      const message = (value: { id: number; text?: string }) => {
        if (value.id !== id) return;
        finish(
          typeof value.text === 'string'
            ? { state: 'available', text: value.text }
            : limited(
                'Сравнение превысило 1 секунду или 10 000 изменений. Откройте «До» или «После».',
              ),
        );
      };
      const failure = () =>
        finish(limited('Сравнение недоступно. Откройте «До» или «После».'), true);
      const timer = setTimeout(
        () => finish(limited('Сравнение превысило 1 секунду. Откройте «До» или «После».'), true),
        1000,
      );
      worker.on('message', message);
      worker.once('error', failure);
      worker.once('exit', failure);
      worker.postMessage({ id, path, ...input });
    });
  }

  /** Следующий worker создаётся лишь после закрытия предыдущего; ошибки запуска не висят в очереди. */
  private startWorker(): Promise<Worker> {
    const compiled = new URL('./change-worker-entry.js', import.meta.url);
    const worker = new Worker(
      existsSync(compiled) ? compiled : new URL('./change-worker-entry.ts', import.meta.url),
    );
    this.worker = worker;
    worker.unref();
    return new Promise((resolve, reject) => {
      let settled = false;
      const clear = () => {
        clearTimeout(timer);
        worker.off('message', ready);
        worker.off('error', failed);
        worker.off('exit', failed);
      };
      const ready = (value: { ready?: boolean }) => {
        if (!value.ready || settled) return;
        settled = true;
        clear();
        resolve(worker);
      };
      const failed = () => {
        if (settled) return;
        settled = true;
        clear();
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate().then(
          () => reject(new Error('Не удалось запустить worker сравнения.')),
          () => reject(new Error('Не удалось запустить worker сравнения.')),
        );
      };
      const timer = setTimeout(failed, 10_000);
      worker.on('message', ready);
      worker.once('error', failed);
      worker.once('exit', failed);
    });
  }

  /** Вытесняет старые результаты по фактическому объёму строк, сохраняя предел 16 МиБ. */
  private remember(job: DiffJob, result: DiffResult): void {
    const bytes = 2 * (result.text.length + (result.reason?.length ?? 0) + job.key.length) + 256;
    if (bytes > maximumBytes) return;
    while (this.bytes + bytes > maximumBytes) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    const previous = this.cache.get(job.key);
    if (previous) this.bytes -= previous.bytes;
    this.cache.set(job.key, { projectId: job.projectId, result, bytes });
    this.bytes += bytes;
  }
}
