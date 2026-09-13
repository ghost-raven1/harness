import { lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { minimatch } from 'minimatch';
import { isWithin } from '../configuration/loader.js';
import type { ToolContext } from './registry.js';

/** Отличает намеренный запрет пути от ошибки доступа файловой системы. */
export class PathPolicyError extends Error {}

/** Проверяет реальные пути, включая символические ссылки и запреты проекта. */
export async function safePath(
  path: string,
  context: ToolContext,
  writing = false,
): Promise<string> {
  const target = resolve(context.workspace, path);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch (error) {
    if (!writing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // ENOENT бывает у оборванной ссылки: writeFile последует по ней без проверки конечного пути.
    const entry = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink())
      throw new PathPolicyError('Нельзя записывать через ссылку на отсутствующий файл.');
    canonical = resolve(await realpath(dirname(target)), target.slice(dirname(target).length + 1));
  }
  if (!isWithin(context.workspace, canonical))
    throw new PathPolicyError('Path is outside workspace');
  const local = relative(context.workspace, canonical).split(sep).join('/');
  if (
    context.config.tools.deniedPaths.some((pattern) =>
      minimatch(local, pattern, { dot: true, nocase: process.platform === 'win32' }),
    )
  )
    throw new PathPolicyError('Path denied by policy');
  return canonical;
}
