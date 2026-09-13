import { mkdir, open, rename, readFile, lstat, unlink } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { id } from '../shared/primitives.js';

/** Синхронизирует содержимое перед атомарной заменой, затем сохраняет запись каталога. */
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, JSON.stringify(value));
}

/** Обновляет зеркало только после commit журнала; отказ снимка не отменяет сохранённое событие. */
export async function writeSnapshot(path: string, value: unknown): Promise<void> {
  try {
    await atomicJson(path, value);
  } catch {
    // Восстановление читает журнал; устаревшее зеркало заменит следующая успешная запись.
  }
}

/** Атомарно заменяет текстовый журнал без сохранения прежнего содержимого. */
export async function atomicText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + id() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    // Удаляем только собственный временный файл; отказ очистки не подменяет ошибку записи.
    await unlink(temporary).catch(() => undefined);
  }
}

/** Windows не предоставляет fsync каталогов; fsync содержимого файла остаётся обязательным. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** Читает JSON, возвращая undefined только при отсутствии файла. */
export async function optionalJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Не допускает переход из внутреннего каталога состояния по ссылке в пользовательские файлы. */
export async function assertRealDirectory(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Внутренняя папка Harness заменена ссылкой: ' + basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
