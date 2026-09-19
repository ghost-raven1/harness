import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, mkdir, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertRealDirectory, syncDirectory } from '../sessions/files.js';
import { ApplicationError } from '../shared/application-error.js';

export const maximumContentManifestBytes = 16 * 1024 * 1024;
/** Проверяет допустимое имя до построения внутренних путей. */
export function contentDirectory(directory: string, projectId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId))
    throw new ApplicationError('INVALID_REQUEST', 'Некорректный идентификатор проекта.');
  return join(directory, 'project-content', projectId);
}
/** Обнаруживает замену файла, прав и содержимого во время чтения. */
function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
/** Проверяет внутренние каталоги без перехода по символическим ссылкам. */
export async function contentDirectories(
  directory: string,
  projectId: string,
  create = false,
): Promise<string> {
  const root = contentDirectory(directory, projectId);
  for (const path of [
    directory,
    dirname(root),
    root,
    join(root, 'blobs'),
    join(root, 'manifests'),
  ]) {
    await assertRealDirectory(path);
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  }
  return root;
}
/** Читает неизменный обычный файл с ограничением размера и без следования ссылкам. */
export async function readContentBytes(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size > BigInt(limit))
    throw new Error('Сохранённое содержимое имеет недопустимый тип или размер.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (identity(await file.stat({ bigint: true })) !== identity(before))
      throw new Error('Файл подменён перед чтением.');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('Сохранённое содержимое оборвано.');
      offset += result.bytesRead;
    }
    if (
      identity(await file.stat({ bigint: true })) !== identity(before) ||
      identity(await lstat(path, { bigint: true })) !== identity(before)
    )
      throw new Error('Содержимое изменилось во время чтения.');
    return bytes;
  } finally {
    await file.close();
  }
}
/** Проверяет байты, а не имя файла: повреждённая копия не становится доказательством. */
export function contentDigest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** Публикует неизменяемый объект после fsync и никогда не перезаписывает существующий файл. */
export async function publishContent(path: string, bytes: Buffer): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!(await readContentBytes(path, bytes.length)).equals(bytes))
        throw new Error('Существующая копия повреждена.');
    }
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
