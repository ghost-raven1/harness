import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, optionalJson, syncDirectory, assertRealDirectory } from '../sessions/files.js';
import type { PurgeRecord } from '../sessions/purge-records.js';

export const dataResetScopeSchema = z.enum(['tasks', 'learning', 'all']);
export type DataResetScope = z.infer<typeof dataResetScopeSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const session = z
  .object({
    sessionId: z.string().uuid(),
    runIds: z.array(z.string().uuid()).min(1),
    requestDigests: z.array(digest),
  })
  .strict();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    scope: dataResetScopeSchema,
    previewToken: digest,
    complete: z.boolean(),
    sessions: z.array(session),
    learningRunIds: z.array(z.string().uuid()),
    exportIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)),
  })
  .strict();
export type DataResetRecord = z.infer<typeof schema>;

/** Намерение хранит только состав и хэши; текста задач, уроков и ключей в нём нет. */
export async function writeResetRecord(directory: string, record: DataResetRecord): Promise<void> {
  await assertRealDirectory(join(directory, 'resets'));
  await atomicJson(join(directory, 'resets', record.previewToken + '.json'), schema.parse(record));
}
export async function readResetRecord(
  directory: string,
  token: string,
): Promise<DataResetRecord | undefined> {
  digest.parse(token);
  await assertRealDirectory(join(directory, 'resets'));
  const record = await optionalJson(join(directory, 'resets', token + '.json'));
  if (!record) return undefined;
  const value = schema.parse(record);
  if (value.previewToken !== token) throw new Error('Повреждён маркер очистки данных.');
  return value;
}
export async function pendingResetRecords(directory: string): Promise<DataResetRecord[]> {
  await assertRealDirectory(join(directory, 'resets'));
  const records: DataResetRecord[] = [];
  for (const name of await names(join(directory, 'resets'))) {
    if (!name.endsWith('.json')) continue;
    const record = await readResetRecord(directory, name.slice(0, -5));
    if (record && !record.complete) records.push(record);
  }
  return records;
}

/** Такие маркеры защищают удалённые запросы; общий сброс сам завершает каскад по своему намерению. */
export function resetSessionRecord(
  record: DataResetRecord,
  item: DataResetRecord['sessions'][number],
): PurgeRecord {
  return {
    schemaVersion: 1,
    ...item,
    candidateIds: [],
    evidenceIds: [],
    reportIds: [],
    previewToken: record.previewToken,
    complete: true,
  };
}

/** Выбирает только штатные экспорты Harness, включая файлы уже отсутствующих уроков. */
export async function lessonExportIds(directory: string): Promise<string[]> {
  const parent = join(directory, 'exports');
  await assertRealDirectory(parent);
  const ids: string[] = [];
  for (const name of await names(parent)) {
    const match = /^Урок Harness ([a-zA-Z0-9_-]+)\.md$/.exec(name);
    if (!match) continue;
    const info = await lstat(join(parent, name));
    if (info.isFile() || info.isSymbolicLink()) ids.push(match[1]!);
  }
  return ids.sort();
}
export async function removeLessonExports(directory: string, ids: string[]): Promise<void> {
  const parent = join(directory, 'exports');
  await assertRealDirectory(parent);
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Некорректное имя экспорта урока.');
    const path = join(parent, 'Урок Harness ' + id + '.md');
    try {
      const info = await lstat(path);
      if (info.isFile() || info.isSymbolicLink()) await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    await syncDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const taskDirectories = ['runs', 'output', 'artifacts', 'file-backups', 'drafts'] as const;
interface StorageEntry {
  path: string;
  size: number;
  modified: number;
}

/** Включает оставшиеся после аварии файлы, которых уже нет в индексе сессий; ссылки не обходит. */
export async function taskStorageInventory(directory: string): Promise<StorageEntry[]> {
  const result: StorageEntry[] = [];
  const visit = async (relative: string): Promise<void> => {
    const path = join(directory, relative),
      info = await lstat(path);
    if (info.isDirectory()) {
      for (const name of await names(path)) await visit(relative + '/' + name);
    } else result.push({ path: relative, size: info.size, modified: info.mtimeMs });
  };
  for (const folder of taskDirectories) {
    await assertRealDirectory(join(directory, folder));
    for (const name of await names(join(directory, folder))) await visit(folder + '/' + name);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Каталоги задач и черновиков принадлежат сервису; настройки и файлы проекта остаются вне них. */
export async function removeTaskStorage(directory: string): Promise<void> {
  for (const folder of taskDirectories) await assertRealDirectory(join(directory, folder));
  for (const folder of taskDirectories)
    await rm(join(directory, folder), { recursive: true, force: true });
  await syncDirectory(directory);
}
export async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
