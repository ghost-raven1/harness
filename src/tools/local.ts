import { readFile, stat } from 'node:fs/promises';
import { executeProgram } from './process.js';
import type { ToolRegistry } from './registry.js';
import type { FileSessionStore } from '../sessions/store.js';
import { safePath } from './paths.js';
import { FileChanges } from './file-changes.js';
import { listDirectory } from './directory-list.js';
import { searchFiles } from './file-search.js';

const object = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Регистрирует схемы и исполнители локальных файлов, процессов и артефактов. */
export function registerLocalTools(registry: ToolRegistry, store: FileSessionStore): void {
  registry.register({
    definition: {
      name: 'fs.read',
      effect: 'read',
      description: 'Read a UTF-8 file inside the workspace.',
      schema: object(
        {
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 32768 },
        },
        ['path'],
      ),
    },
    /** Читает ограниченный фрагмент UTF-8 после проверки пути и размера файла. */
    async execute(args, context) {
      const path = await safePath(args.path as string, context);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 64 * 1024 * 1024)
        throw new Error('Read requires a regular file of at most 64 MiB');
      const content = await readFile(path, { encoding: 'utf8', signal: context.signal });
      return {
        content: content.slice(
          (args.offset as number) ?? 0,
          ((args.offset as number) ?? 0) + ((args.limit as number) ?? 32768),
        ),
        totalCharacters: content.length,
      };
    },
  });
  registry.register({
    definition: {
      name: 'fs.list',
      effect: 'read',
      description:
        'List workspace entries. With only path, returns the complete array. Explicit offset/limit returns {entries,total,offset,nextOffset}; use nextOffset for the next page.',
      schema: object(
        {
          path: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
        ['path'],
      ),
    },
    /** Возвращает список каталога целиком либо страницу по переданным границам. */
    async execute(args, context) {
      return listDirectory(args as { path: string; offset?: number; limit?: number }, context);
    },
  });
  registry.register({
    definition: {
      name: 'fs.write',
      effect: 'write',
      description: 'Write a UTF-8 file. Parent directory must already exist.',
      schema: object(
        { path: { type: 'string' }, content: { type: 'string', maxLength: 1048576 } },
        ['path', 'content'],
      ),
    },
    /** Передаёт запись файла в механизм резервирования и проверки предпросмотра. */
    async execute(args, context) {
      return new FileChanges(store).write(args.path as string, args.content as string, context);
    },
  });
  registry.register({
    definition: {
      name: 'fs.search',
      effect: 'read',
      description:
        'Find a literal string in workspace text files; skips dependencies, symlinks and Git metadata. Returns at most 100 matches, scans at most 1000 files and discovers at most 1000 directories. Check incomplete/reason before concluding no matches exist; narrow path when a limit is reached.',
      schema: object({ path: { type: 'string' }, text: { type: 'string', minLength: 1 } }, [
        'path',
        'text',
      ]),
    },
    /** Ищет буквальный текст в разрешённых файлах с признаком неполной выдачи. */
    async execute(args, context) {
      return searchFiles(args as { path: string; text: string }, context);
    },
  });
  registry.register({
    definition: {
      name: 'process.exec',
      effect: 'write',
      description:
        'Execute a program with literal argv in the workspace. It has the OS rights of the user.',
      schema: object(
        {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' }, maxItems: 100 },
        },
        ['command', 'args'],
      ),
    },
    /** Запускает программу с отдельными аргументами в рабочей папке задачи. */
    execute(args, context) {
      return executeProgram(args.command as string, args.args as string[], context);
    },
  });
  registry.register({
    definition: {
      name: 'artifacts.read',
      effect: 'read',
      description:
        'Read a portion of a large tool result belonging to this conversation and workspace.',
      schema: object(
        {
          id: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 32768 },
        },
        ['id'],
      ),
    },
    /** Читает страницу артефакта, доступного текущей беседе и рабочей папке. */
    execute(args, context) {
      return store.readArtifact(
        context.runId,
        args.id as string,
        (args.offset as number) ?? 0,
        (args.limit as number) ?? 32768,
      );
    },
  });
}
