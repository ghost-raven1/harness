import { mkdir, open, readFile, truncate } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { syncDirectory } from './files.js';

// Неясный исход отката требует нового процесса: старый кэш уже нельзя дописывать в этот файл.
const blockedJournals = new Set<string>();

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

/** Дописывает пачку единственного писателя; при отказе возвращает файл к прежней длине. */
export async function appendJournalBatch(path: string, events: unknown[]): Promise<void> {
  const canonical = resolve(path);
  if (blockedJournals.has(canonical))
    throw new Error(
      'Журнал требует восстановления. Перезапустите Harness: закройте окно с запущенным сервисом и откройте его заново.',
    );
  const content = events.map((event) => JSON.stringify(event) + '\n').join('');
  if (!content) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'a', 0o600);
  let previousSize: number | undefined;
  try {
    try {
      previousSize = (await file.stat()).size;
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    if (previousSize !== undefined) {
      try {
        // Убираем всю неподтверждённую пачку, включая полные строки перед оборванным хвостом.
        const recovery = await open(path, 'r+');
        try {
          await recovery.truncate(previousSize);
          await recovery.sync();
        } finally {
          await recovery.close();
        }
        await syncDirectory(dirname(path));
      } catch (recoveryError) {
        blockedJournals.add(canonical);
        throw new Error(
          'Не удалось восстановить журнал после ошибки записи. Перезапустите Harness: закройте окно с запущенным сервисом и откройте его заново.',
          { cause: new AggregateError([error, recoveryError]) },
        );
      }
    }

    throw error;
  }
}
