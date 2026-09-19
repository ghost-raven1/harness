import { join } from 'node:path';
import { atomicJson, optionalJson } from './files.js';
import type { StateFiles } from './ports.js';

/** Файловый адаптер двух существующих служебных документов с атомарной записью. */
export class FileStateFiles implements StateFiles {
  constructor(private readonly directory: string) {}

  /** Отсутствующий документ даёт начальное состояние; повреждение остаётся ошибкой. */
  read(name: 'usage' | 'iteration-settings'): Promise<unknown | undefined> {
    return optionalJson(join(this.directory, name + '.json'));
  }

  /** Подтверждает изменение только после синхронизации временной копии и каталога. */
  write(name: 'usage' | 'iteration-settings', value: unknown): Promise<void> {
    return atomicJson(join(this.directory, name + '.json'), value);
  }
}
