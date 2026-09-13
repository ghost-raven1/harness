import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';

export class UnsafeDiagnosticPath extends Error {}

/** Журнал не следует за ссылками и не меняет файлы, имеющие внешние жёсткие ссылки. */
export async function checkDiagnosticFile(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink() || value.nlink > 1)
      throw new UnsafeDiagnosticPath();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function diagnosticDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink()) throw new UnsafeDiagnosticPath();
}

/** O_NOFOLLOW защищает открытие последнего компонента между проверкой и записью. */
export async function appendDiagnostic(path: string, line: string): Promise<void> {
  await checkDiagnosticFile(path);
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink > 1) throw new UnsafeDiagnosticPath();
    await file.writeFile(line);
  } finally {
    await file.close();
  }
}
