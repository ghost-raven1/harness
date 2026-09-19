import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRealDirectory } from './files.js';

/** Полный результат читается только при доказанном владельце и с ограничением реальных байтов. */
export interface BoundedArtifactReader {
  readOwnedArtifact(runId: string, artifactId: string, maximumBytes: number): Promise<string>;
  ownedArtifactVersion(runId: string, artifactId: string, maximumBytes: number): Promise<string>;
}

/** Не следует ссылкам и замечает замену файла во время ограниченного чтения. */
export async function readBoundedArtifact(
  directory: string,
  runId: string,
  artifactId: string,
  maximumBytes: number,
): Promise<string> {
  for (const value of [runId, artifactId])
    if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Некорректный идентификатор артефакта.');
  for (const folder of [
    directory,
    join(directory, 'artifacts'),
    join(directory, 'artifacts', runId),
  ])
    await assertRealDirectory(folder);
  const path = join(directory, 'artifacts', runId, artifactId + '.txt');
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes))
    throw new Error('Недоступный или слишком большой результат проверки.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const state = (value: typeof before) =>
    [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
  try {
    if (state(await file.stat({ bigint: true })) !== state(before))
      throw new Error('Артефакт изменился перед чтением.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      bytes += chunk.length;
      if (bytes > maximumBytes) throw new Error('Результат превысил допустимый размер.');
      chunks.push(chunk);
    }
    if (
      state(await file.stat({ bigint: true })) !== state(before) ||
      state(await lstat(path, { bigint: true })) !== state(before)
    )
      throw new Error('Артефакт изменился во время чтения.');
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await file.close();
  }
}

/** Версия файла позволяет не возвращать удалённое или изменённое доказательство из кэша. */
export async function boundedArtifactVersion(
  directory: string,
  runId: string,
  artifactId: string,
  maximumBytes: number,
): Promise<string> {
  for (const value of [runId, artifactId])
    if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Некорректный идентификатор артефакта.');
  for (const folder of [
    directory,
    join(directory, 'artifacts'),
    join(directory, 'artifacts', runId),
  ])
    await assertRealDirectory(folder);
  const meta = await lstat(join(directory, 'artifacts', runId, artifactId + '.txt'), {
    bigint: true,
  });
  if (!meta.isFile() || meta.nlink !== 1n || meta.size > BigInt(maximumBytes))
    throw new Error('Недоступный или слишком большой результат проверки.');
  return [meta.dev, meta.ino, meta.size, meta.mtimeNs, meta.ctimeNs].join(':');
}
