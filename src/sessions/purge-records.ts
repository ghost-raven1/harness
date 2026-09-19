import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, optionalJson, syncDirectory, assertRealDirectory } from './files.js';
import { removeSessionDrafts } from './drafts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    runIds: z.array(z.string().uuid()).min(1),
    requestDigests: z.array(digest),
    candidateIds: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    reportIds: z.array(z.string()),
    previewToken: digest,
    complete: z.boolean(),
  })
  .strict();
export type PurgeRecord = z.infer<typeof schema>;
export const purgeRecordSchema = schema;

/** Маркеры не содержат текста задачи; они запрещают повторное исполнение удалённого запроса. */
export async function readPurgeRecords(directory: string): Promise<PurgeRecord[]> {
  await assertRealDirectory(join(directory, 'purged'));
  const records: PurgeRecord[] = [];
  for (const name of await names(join(directory, 'purged'))) {
    if (!name.endsWith('.json')) continue;
    const record = schema.parse(await optionalJson(join(directory, 'purged', name)));
    if (name !== record.sessionId + '.json') throw new Error('Повреждён маркер удаления беседы.');
    records.push(record);
  }
  return records;
}

/** Атомарно сохраняет проверенный маркер удаления в служебном каталоге. */
export async function writePurgeRecord(directory: string, record: PurgeRecord): Promise<void> {
  await assertRealDirectory(join(directory, 'purged'));
  await atomicJson(join(directory, 'purged', record.sessionId + '.json'), schema.parse(record));
}

/** Удаляет только внутренние данные выбранных запусков, не обращаясь к рабочим папкам. */
export async function removeRunFiles(directory: string, record: PurgeRecord): Promise<void> {
  const unsafe = await linkedPurgeDirectories(directory);
  if (unsafe.length)
    throw new Error('Внутренний каталог Harness заменён ссылкой: ' + unsafe.join(', '));
  const runIds = new Set(record.runIds);
  await removeSessionDrafts(directory, record.sessionId, record.requestDigests);
  for (const folder of ['runs', 'output', 'indexes/runs', 'indexes/output', 'search']) {
    const parent = join(directory, folder);
    for (const name of await names(parent)) {
      const runId = name.slice(0, 36);
      if (runIds.has(runId) && /^\.(?:jsonl?|txt)(?:\.[a-f0-9-]+\.tmp)?$/.test(name.slice(36)))
        await rm(join(parent, name), { force: true });
    }
    await syncExisting(parent);
  }
  for (const folder of ['artifacts', 'file-backups']) {
    const parent = join(directory, folder);
    for (const runId of record.runIds)
      await rm(join(parent, runId), { recursive: true, force: true });
    await syncExisting(parent);
  }
  for (const candidateId of record.candidateIds) {
    // Идентификатор из состояния не должен превращать имя экспорта в произвольный путь.
    if (!/^[a-zA-Z0-9_-]+$/.test(candidateId)) continue;
    const path = join(directory, 'exports', 'Урок Harness ' + candidateId + '.md');
    try {
      const info = await lstat(path);
      if (info.isFile() || info.isSymbolicLink()) await rm(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await syncExisting(join(directory, 'exports'));
}

/** Не позволяет очистке пройти через ссылку из внутреннего каталога в рабочую папку. */
export async function linkedPurgeDirectories(directory: string): Promise<string[]> {
  const linked: string[] = [];
  for (const folder of [
    'runs',
    'output',
    'indexes',
    'indexes/runs',
    'indexes/output',
    'search',
    'artifacts',
    'file-backups',
    'exports',
    'purged',
    'resets',
    'drafts',
    'project-records',
    'project-index',
    'project-artifacts',
    'project-content',
    'project-purges',
  ]) {
    try {
      if ((await lstat(join(directory, folder))).isSymbolicLink()) linked.push(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return linked;
}

/** Убирает незавершённые атомарные копии, которые могли остаться после аварии. */
export async function removeLearningTemps(directory: string): Promise<void> {
  for (const name of await names(directory))
    if (/^learning\.jsonl?\.[a-f0-9-]+\.tmp$/.test(name))
      await rm(join(directory, name), { force: true });
  await syncExisting(directory);
}

/** Перечисляет каталог, считая отсутствующий каталог пустым. */
async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
/** Синхронизирует существующий каталог после удаления его файлов. */
async function syncExisting(directory: string): Promise<void> {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
