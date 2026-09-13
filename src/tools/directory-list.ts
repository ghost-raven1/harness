import { readdir } from 'node:fs/promises';
import { abort } from '../shared/primitives.js';
import { safePath } from './paths.js';
import type { ToolContext } from './registry.js';

interface DirectoryEntry {
  name: string;
  directory: boolean;
  symlink: boolean;
}
interface DirectoryPage {
  entries: DirectoryEntry[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

/** Сохраняет полный массив для прежних вызовов; явные offset/limit включают страницы. */
export async function listDirectory(
  args: { path: string; offset?: number; limit?: number },
  context: ToolContext,
): Promise<DirectoryEntry[] | DirectoryPage> {
  abort(context.signal);
  const path = await safePath(args.path, context);
  abort(context.signal);
  const contents = await readdir(path, { withFileTypes: true });
  abort(context.signal);
  contents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const entry = (item: (typeof contents)[number]): DirectoryEntry => ({
    name: item.name,
    directory: item.isDirectory(),
    symlink: item.isSymbolicLink(),
  });
  if (args.offset === undefined && args.limit === undefined) return contents.map(entry);
  const offset = args.offset ?? 0;
  const entries = contents.slice(offset, offset + (args.limit ?? 500)).map(entry);
  return {
    entries,
    total: contents.length,
    offset,
    nextOffset: offset + entries.length < contents.length ? offset + entries.length : null,
  };
}
