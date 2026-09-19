import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, assertRealDirectory, optionalJson, syncDirectory } from '../sessions/files.js';
import { purgeRecordSchema } from '../sessions/purge-records.js';
import { hash } from '../shared/primitives.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const draftName = /^(?:new|[a-f0-9-]{36})\.[a-f0-9-]{36}\.json(?:\.[a-f0-9-]+\.tmp)?$/;
export const projectPurgeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    requestDigest: digest,
    previewToken: digest,
    complete: z.boolean(),
    preserveLearning: z.boolean().default(false),
    sessions: z.array(purgeRecordSchema),
    draftFiles: z.array(z.string().regex(draftName)),
  })
  .strict();
export type ProjectPurgeRecord = z.infer<typeof projectPurgeRecordSchema>;

/** Читает маркеры, включая более раннее намерение общего сброса до записи отдельных маркеров. */
export async function readProjectPurgeRecords(directory: string): Promise<ProjectPurgeRecord[]> {
  const records = new Map<string, ProjectPurgeRecord>();
  for (const folder of ['project-purges', 'resets']) {
    await assertRealDirectory(join(directory, folder));
    for (const name of await names(join(directory, folder))) {
      if (!name.endsWith('.json')) continue;
      const raw = await optionalJson<unknown>(join(directory, folder, name));
      if (folder === 'project-purges') {
        const record = projectPurgeRecordSchema.parse(raw);
        if (name !== record.projectId + '.json')
          throw new Error('Повреждён маркер удаления проекта.');
        records.set(record.projectId, record);
      } else {
        const reset = z
          .object({
            schemaVersion: z.literal(1),
            previewToken: digest,
            projects: z.array(projectPurgeRecordSchema).optional(),
          })
          .passthrough()
          .parse(raw);
        for (const record of reset.projects ?? []) {
          if (reset.previewToken !== record.previewToken || !record.preserveLearning)
            throw new Error('Повреждён состав проектов общего сброса.');
          if (!records.has(record.projectId)) records.set(record.projectId, record);
        }
      }
    }
  }
  return [...records.values()];
}

/** Намерение не содержит целей, ключей подключения и исходного текста проекта. */
export async function writeProjectPurgeRecord(
  directory: string,
  input: ProjectPurgeRecord,
): Promise<void> {
  const record = projectPurgeRecordSchema.parse(input);
  await assertRealDirectory(join(directory, 'project-purges'));
  await atomicJson(join(directory, 'project-purges', record.projectId + '.json'), record);
}

/** Состав черновиков закрепляется до удаления основного файла, включая атомарные временные копии. */
export async function projectDraftFiles(
  directory: string,
  projectId: string,
  requestDigest: string,
): Promise<string[]> {
  const folder = join(directory, 'drafts');
  await assertRealDirectory(folder);
  const files = (await names(folder))
    .filter((name) => draftName.test(name))
    .sort((a, b) => Number(a.endsWith('.tmp')) - Number(b.endsWith('.tmp')) || a.localeCompare(b));
  const selected = new Set<string>();
  const prefixes = new Set<string>();
  const mainFiles = new Set(files.filter((name) => !name.endsWith('.tmp')));
  for (const name of files) {
    if ([...prefixes].some((prefix) => name.startsWith(prefix + '.'))) {
      selected.add(name);
      continue;
    }
    if (name.endsWith('.tmp') && mainFiles.has(name.replace(/\.[a-f0-9-]+\.tmp$/, ''))) continue;
    const path = join(folder, name);
    const meta = await lstat(path);
    if (!meta.isFile()) continue;
    const raw = await optionalJson<unknown>(path);
    const draft = z
      .object({
        requestKey: z.string(),
        scope: z.object({ projectId: z.string().uuid().optional() }).passthrough(),
      })
      .passthrough()
      .parse(raw);
    if (draft.scope.projectId === projectId || hash(draft.requestKey) === requestDigest) {
      selected.add(name);
      prefixes.add(name.replace(/\.[a-f0-9-]+\.tmp$/, ''));
    }
  }
  for (const name of files)
    if ([...prefixes].some((prefix) => name === prefix || name.startsWith(prefix + '.')))
      selected.add(name);
  return [...selected].sort();
}

/** Удаляет только внутренние файлы проекта; конфиги мастера в projects/ остаются на месте. */
export async function removeProjectFiles(
  directory: string,
  input: ProjectPurgeRecord,
): Promise<void> {
  const record = projectPurgeRecordSchema.parse(input);
  for (const name of ['project-records', 'project-index', 'project-artifacts', 'drafts'])
    await assertRealDirectory(join(directory, name));
  for (const folder of ['project-records', 'project-index']) {
    for (const name of await names(join(directory, folder)))
      if (
        name.startsWith(record.projectId + '.') &&
        /^\.(?:plans\.json|jsonl?)(?:\.[a-f0-9-]+\.tmp)?$/.test(name.slice(record.projectId.length))
      )
        await rm(join(directory, folder, name), { force: true });
    await syncExisting(join(directory, folder));
  }
  await rm(join(directory, 'project-artifacts', record.projectId), {
    recursive: true,
    force: true,
  });
  for (const path of [join(directory, 'exports'), join(directory, 'exports', 'projects')])
    await assertRealDirectory(path);
  await rm(join(directory, 'exports', 'projects', record.projectId), {
    recursive: true,
    force: true,
  });
  await syncExisting(join(directory, 'exports', 'projects'));
  await syncExisting(join(directory, 'project-artifacts'));
  for (const name of record.draftFiles) await rm(join(directory, 'drafts', name), { force: true });
  await syncExisting(join(directory, 'drafts'));
}

/** Отсутствующий каталог уже соответствует завершённой очистке. */
async function names(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Подтверждает удаление в существующем каталоге. */
async function syncExisting(directory: string): Promise<void> {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
