import { mkdir, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { syncDirectory } from './files.js';

// Неясный исход отката требует нового процесса: старый кэш уже нельзя дописывать в этот файл.
const blockedJournals = new Set<string>();

/** Сообщает точную границу завершённых записей без изменения источника. */
export class JournalReadError extends Error {
  constructor(
    readonly code: string,
    readonly offset: number,
  ) {
    super(code);
  }
}

/** Потоково читает JSONL; память ограничена одной записью и буфером чтения. */
export async function* scanJournal<T = unknown>(
  path: string,
  start = 0,
  maximumRecordBytes = 512 * 1024 * 1024,
): AsyncGenerator<{ value: T; offset: number; end: number }> {
  const stream = createReadStream(path, { start, highWaterMark: 64 * 1024 });
  let parts: Buffer[] = [],
    length = 0,
    offset = start;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      let begin = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, begin)) {
        const fragment = bytes.subarray(begin, end);
        const line = parts.length
          ? Buffer.concat([...parts, fragment], length + fragment.length)
          : fragment;
        const next = offset + length + fragment.length + 1;
        if (line.length > maximumRecordBytes)
          throw new JournalReadError('JOURNAL_RECORD_TOO_LARGE', offset);
        let value: T;
        try {
          value = JSON.parse(line.toString('utf8')) as T;
        } catch {
          throw new JournalReadError('JOURNAL_CORRUPT_RECORD', offset);
        }
        yield { value, offset, end: next };
        offset = next;
        parts = [];
        length = 0;
        begin = end + 1;
      }
      if (begin < bytes.length) {
        const fragment = bytes.subarray(begin);
        parts.push(fragment);
        length += fragment.length;
        if (length > maximumRecordBytes)
          throw new JournalReadError('JOURNAL_RECORD_TOO_LARGE', offset);
      }
    }
    if (length) throw new JournalReadError('JOURNAL_TORN_TAIL', offset);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    stream.destroy();
  }
}

/** Обычное чтение не ремонтирует журнал и не пропускает повреждённые строки. */
export async function readJournal<T>(path: string): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of scanJournal<T>(path)) rows.push(row.value);
  return rows;
}

/** Владелец состояния удаляет только оборванный хвост до запуска исполнителей. */
export async function repairJournalTail(path: string): Promise<void> {
  try {
    for await (const _row of scanJournal(path)) {
      /* Проверяем и завершённые строки. */
    }
  } catch (error) {
    if (!(error instanceof JournalReadError) || error.code !== 'JOURNAL_TORN_TAIL') throw error;
    const file = await open(path, 'r+');
    try {
      await file.truncate(error.offset);
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(dirname(path));
  }
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
