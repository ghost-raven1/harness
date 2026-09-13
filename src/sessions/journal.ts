import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncDirectory } from './files.js';

/** Читает завершённые события; удаляет только хвост без завершающего перевода строки. */
export async function readJournal<T>(path: string): Promise<T[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const completeLength = bytes.lastIndexOf(10) + 1;
  if (completeLength < bytes.length) await truncate(path, completeLength);
  const lines = bytes.subarray(0, completeLength).toString('utf8').split('\n').filter(Boolean);
  // Структуру конкретного события проверяет хранилище своего модуля.
  return lines.map((line) => JSON.parse(line) as T);
}

/** Завершает запись и fsync до возврата управления исполнителю побочного эффекта. */
export async function appendJournal(path: string, event: unknown): Promise<void> {
  await appendJournalBatch(path, [event]);
}

/** Записывает небольшую пачку событий одним fsync, сохраняя JSONL совместимость. */
export async function appendJournalBatch(path: string, events: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'a', 0o600);
  try {
    await file.writeFile(events.map((event) => JSON.stringify(event) + '\n').join(''));
    await file.sync();
  } finally {
    await file.close();
  }

  await syncDirectory(dirname(path));
}
