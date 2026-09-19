/** Ограничивает исторические снимки по размеру сериализованных данных, сохраняя порядок LRU. */
export class HistoryCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(readonly maximumBytes = 64 * 1024 * 1024) {}
  /** Чтение делает запись последней использованной. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  /** Большой снимок возвращается читателю напрямую, но не вытесняет весь кэш. */
  set(key: string, value: T): void {
    this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value)) * 2;
    if (bytes > this.maximumBytes) return;
    while (this.bytes + bytes > this.maximumBytes) this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
  /** Удаляет данные вместе с учтённым размером. */
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  /** Счётчики не содержат пользовательские данные. */
  stats(): { bytes: number; maximumBytes: number; entries: number } {
    return { bytes: this.bytes, maximumBytes: this.maximumBytes, entries: this.entries.size };
  }
}
