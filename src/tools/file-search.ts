import { opendir, readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { abort } from '../shared/primitives.js';
import { PathPolicyError, safePath } from './paths.js';
import type { ToolContext } from './registry.js';

type IncompleteReason = 'file_limit' | 'directory_limit' | 'match_limit' | 'unreadable';
interface SearchResult {
  matches: Array<{ path: string; line: number; text: string }>;
  visited: number;
  scannedDirectories: number;
  incomplete: boolean;
  reason: IncompleteReason | null;
}
const excluded = new Set(['node_modules', '.git', '.harness', '.tools']);
const maxFiles = 1000;
const maxDirectories = 1000;
const maxMatches = 100;

/** Ограничивает файлы и каталоги независимо; неполный обход не выдаётся за отсутствие совпадений. */
export async function searchFiles(
  args: { path: string; text: string },
  context: ToolContext,
): Promise<SearchResult> {
  abort(context.signal);
  const result: SearchResult = {
    matches: [],
    visited: 0,
    scannedDirectories: 0,
    incomplete: false,
    reason: null,
  };
  const incomplete = (reason: IncompleteReason): SearchResult => {
    result.incomplete = true;
    result.reason = reason;
    return result;
  };
  let root: string;
  try {
    root = await safePath(args.path, context);
  } catch (error) {
    abort(context.signal);
    if (error instanceof PathPolicyError) throw error;
    return incomplete('unreadable');
  }
  const roots = [root];
  // Считаем также поставленные в очередь каталоги, чтобы широкий уровень не раздувал память.
  for (let index = 0; index < roots.length; index++) {
    abort(context.signal);
    try {
      const root = await safePath(roots[index]!, context);
      const directory = await opendir(root);
      result.scannedDirectories++;
      for await (const entry of directory) {
        abort(context.signal);
        if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
        const path = resolve(root, entry.name);
        if (entry.isDirectory()) {
          try {
            await safePath(path, context);
          } catch (error) {
            abort(context.signal);
            if (!(error instanceof PathPolicyError)) incomplete('unreadable');
            continue;
          }
          if (roots.length >= maxDirectories) return incomplete('directory_limit');
          roots.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          await safePath(path, context);
          if (result.visited >= maxFiles) return incomplete('file_limit');
          result.visited++;
          if ((await stat(path)).size > 1048576) continue;
          const content = await readFile(path, { encoding: 'utf8', signal: context.signal });
          if (content.length > 1048576 || content.includes('\0')) continue;
          const lines = content.split('\n');
          for (let line = 0; line < lines.length; line++) {
            abort(context.signal);
            if (!lines[line]!.includes(args.text)) continue;
            if (result.matches.length >= maxMatches) return incomplete('match_limit');
            result.matches.push({
              path: relative(context.workspace, path),
              line: line + 1,
              text: lines[line]!.slice(0, 500),
            });
          }
        } catch (error) {
          abort(context.signal);
          if (!(error instanceof PathPolicyError)) incomplete('unreadable');
        }
      }
    } catch (error) {
      abort(context.signal);
      if (!(error instanceof PathPolicyError)) incomplete('unreadable');
    }
  }
  abort(context.signal);
  return result;
}
