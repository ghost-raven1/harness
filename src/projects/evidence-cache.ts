import { z } from 'zod';

export const maximumEvidenceBytes = 16 * 1024 * 1024;
const resultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  stdoutTruncated: z.boolean().default(false),
  stderrTruncated: z.boolean().default(false),
});
export type CheckResult = z.infer<typeof resultSchema>;

/** Ограниченный LRU объединяет одновременное декодирование одного подтверждённого результата. */
export class EvidenceCache {
  private readonly entries = new Map<
    string,
    { projectId: string; value: CheckResult; bytes: number }
  >();
  private readonly pending = new Map<string, Promise<CheckResult>>();
  private generation = 0;
  private bytes = 0;

  /** После удаления уже начатое чтение не может воскресить запись в кэше. */
  forget(projectId?: string): void {
    this.generation++;
    for (const [key, entry] of this.entries)
      if (!projectId || entry.projectId === projectId) {
        this.entries.delete(key);
        this.bytes -= entry.bytes;
      }
    this.pending.clear();
  }
  /** Читатель фиксирует поколение раньше первого асинхронного обращения к источнику. */
  revision(): number {
    return this.generation;
  }
  /** Метрики нужны для проверок ограничения, а не для раскрытия текста журналов. */
  stats() {
    return {
      bytes: this.bytes,
      entries: this.entries.size,
      pending: this.pending.size,
      maximumBytes: maximumEvidenceBytes,
    };
  }

  /** Декодирует только ограниченный JSON; вычисление ключа и владельца остаётся у сервиса. */
  async get(
    projectId: string,
    key: string,
    read: () => Promise<string>,
    expectedGeneration = this.generation,
  ): Promise<CheckResult> {
    if (expectedGeneration !== this.generation)
      throw new Error('Доказательство удалено во время чтения.');
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const promise = (async () => {
      const raw = await read();
      if (Buffer.byteLength(raw) > maximumEvidenceBytes)
        throw new Error('Результат превышает 16 МиБ.');
      const value = resultSchema.parse(JSON.parse(raw));
      const bytes = 2 * (value.stdout.length + value.stderr.length) + 256;
      if (bytes <= maximumEvidenceBytes && generation === this.generation) {
        while (this.bytes + bytes > maximumEvidenceBytes) {
          const oldest = this.entries.entries().next().value;
          if (!oldest) break;
          this.entries.delete(oldest[0]);
          this.bytes -= oldest[1].bytes;
        }
        this.entries.set(key, { projectId, value, bytes });
        this.bytes += bytes;
      }
      return value;
    })();
    this.pending.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    }
  }
}
