import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, test } from 'vitest';

const sourceRoot = resolve('src');

/** Разбирает импорты и повторные экспорты, включая зависимости только для типов. */
async function dependencies(directory: string): Promise<Array<{ source: string; target: string }>> {
  const result: Array<{ source: string; target: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await dependencies(path)));
    else if (entry.name.endsWith('.ts')) {
      const source = ts.createSourceFile(
        path,
        await readFile(path, 'utf8'),
        ts.ScriptTarget.Latest,
      );
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.'))
          continue;
        result.push({
          source: relative(sourceRoot, path).replaceAll('\\', '/'),
          target: relative(sourceRoot, resolve(dirname(path), specifier.text)).replaceAll(
            '\\',
            '/',
          ),
        });
      }
    }
  }
  return result;
}

test('runtime и доменные сервисы зависят от портов, а не CLI и файловых хранилищ', async () => {
  const edges = (
    await Promise.all(
      ['runtime', 'agents', 'context', 'policy', 'learning'].map((name) =>
        dependencies(resolve(sourceRoot, name)),
      ),
    )
  ).flat();
  const adapters = new Set([
    'sessions/store.js',
    'sessions/archive.js',
    'sessions/journal.js',
    'sessions/journal-index.js',
    'sessions/catalog.js',
    'sessions/output.js',
    'sessions/files.js',
    'sessions/state-files.js',
    'learning/store.js',
  ]);
  expect(
    edges.filter(
      (edge) =>
        edge.source !== 'learning/store.ts' &&
        (edge.target.startsWith('interfaces/') || adapters.has(edge.target)),
    ),
  ).toEqual([]);
});

test('файловое хранение не запускает runtime и прикладные операции', async () => {
  const edges = await dependencies(resolve(sourceRoot, 'sessions'));
  expect(
    edges.filter(
      (edge) =>
        // Старый публичный путь остаётся коротким экспортом для существующих интеграций.
        edge.source !== 'sessions/purge.ts' &&
        /^(runtime|application|interfaces)\//.test(edge.target),
    ),
  ).toEqual([]);
});

test('прикладные команды не импортируют транспорт и форматирование экранов', async () => {
  const edges = await dependencies(resolve(sourceRoot, 'application'));
  expect(edges.filter((edge) => edge.target.startsWith('interfaces/'))).toEqual([]);
});
