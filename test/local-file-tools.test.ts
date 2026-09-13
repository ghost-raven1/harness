import { beforeEach, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import { listDirectory } from '../src/tools/directory-list.js';
import { searchFiles } from '../src/tools/file-search.js';
import type { ToolContext } from '../src/tools/registry.js';
import { call, fixtureConfig, harness, output, ScriptedProvider, temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    realpath: vi.fn(actual.realpath),
    opendir: vi.fn(actual.opendir),
    readFile: vi.fn(actual.readFile),
  };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');
beforeEach(() => {
  vi.mocked(files.readdir).mockReset().mockImplementation(actual.readdir);
  vi.mocked(files.realpath).mockReset().mockImplementation(actual.realpath);
  vi.mocked(files.opendir).mockReset().mockImplementation(actual.opendir);
  vi.mocked(files.readFile).mockReset().mockImplementation(actual.readFile);
});

async function context(signal = new AbortController().signal): Promise<ToolContext> {
  const workspace = await temporary();
  return { workspace, signal, runId: 'file-tools', config: fixtureConfig(workspace) };
}

async function createEntries(count: number, create: (name: string) => Promise<unknown>) {
  for (let offset = 0; offset < count; offset += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, count - offset) }, (_, index) =>
        create(String(offset + index).padStart(4, '0')),
      ),
    );
}

it('прежний вызов списка возвращает все 501 записи, страницы позволяют получить остаток', async () => {
  const ctx = await context();
  await createEntries(501, (name) => files.writeFile(join(ctx.workspace, name), ''));
  const all = await listDirectory({ path: '.' }, ctx);
  expect(Array.isArray(all)).toBe(true);
  expect(all).toHaveLength(501);
  expect(all).toContainEqual({ name: '0500', directory: false, symlink: false });
  const first = await listDirectory({ path: '.', limit: 500 }, ctx);
  expect(first).toMatchObject({ total: 501, offset: 0, nextOffset: 500 });
  expect('entries' in first && first.entries).toHaveLength(500);
  const last = await listDirectory({ path: '.', offset: 500 }, ctx);
  expect(last).toEqual({
    entries: [{ name: '0500', directory: false, symlink: false }],
    total: 501,
    offset: 500,
    nextOffset: null,
  });
  expect(await listDirectory({ path: '.', offset: 700 }, ctx)).toEqual({
    entries: [],
    total: 501,
    offset: 700,
    nextOffset: null,
  });
});

it('список сохраняет типы папок и ссылок', async () => {
  const ctx = await context();
  await files.mkdir(join(ctx.workspace, 'folder'));
  await files.symlink(join(ctx.workspace, 'folder'), join(ctx.workspace, 'link'));
  expect(await listDirectory({ path: '.' }, ctx)).toEqual([
    { name: 'folder', directory: true, symlink: false },
    { name: 'link', directory: false, symlink: true },
  ]);
});

it('большой прежний список сохраняется в артефакте целиком вместе с 501-й записью', async () => {
  const app = await harness(
    new ScriptedProvider((_, index) =>
      index ? output('Просмотрено') : output('', [call('list', 'fs.list', { path: '.' })]),
    ),
    (config) => {
      config.tools.resultBytes = 256;
    },
  );
  await createEntries(501, (name) => files.writeFile(join(app.workspace, name), ''));
  const { runId } = await app.runtime.start({
    message: 'Просмотри папку',
    workspace: app.workspace,
    requestKey: 'complete-list',
  });
  await app.runtime.wait(runId);
  const run = app.sessions.get(runId);
  const result = JSON.parse(Object.values(run.invocations)[0]!.result!);
  expect(result.truncated).toBe(true);
  const entries = JSON.parse(await app.sessions.readArtifact(runId, result.artifactId, 0, 32768));
  expect(entries).toHaveLength(501);
  expect(entries).toContainEqual({ name: '0500', directory: false, symlink: false });
});

it('поиск сообщает о 1001-м файле и отличает предел от полного обхода ровно 1000 файлов', async () => {
  const ctx = await context();
  await createEntries(1001, (name) => files.writeFile(join(ctx.workspace, name), 'Другой текст'));
  expect(await searchFiles({ path: '.', text: 'Искомый текст' }, ctx)).toMatchObject({
    matches: [],
    visited: 1000,
    scannedDirectories: 1,
    incomplete: true,
    reason: 'file_limit',
  });
  await files.unlink(join(ctx.workspace, '1000'));
  expect(await searchFiles({ path: '.', text: 'Искомый текст' }, ctx)).toMatchObject({
    visited: 1000,
    incomplete: false,
    reason: null,
  });
});

it('пустые папки расходуют бюджет: корень и 999 подпапок допускают полный обход', async () => {
  const ctx = await context();
  await createEntries(1000, (name) => files.mkdir(join(ctx.workspace, name)));
  const limited = await searchFiles({ path: '.', text: 'Текст' }, ctx);
  expect(limited).toMatchObject({ visited: 0, incomplete: true, reason: 'directory_limit' });
  expect(limited.scannedDirectories).toBeLessThanOrEqual(1000);
  await files.rmdir(join(ctx.workspace, '0999'));
  expect(await searchFiles({ path: '.', text: 'Текст' }, ctx)).toEqual({
    matches: [],
    visited: 0,
    scannedDirectories: 1000,
    incomplete: false,
    reason: null,
  });
});

it('поиск отличает 100 совпадений от неполной выдачи 101-го', async () => {
  const ctx = await context();
  const path = join(ctx.workspace, 'match.txt');
  await files.writeFile(path, Array(101).fill('Искомый текст').join('\n'));
  const limited = await searchFiles({ path: '.', text: 'Искомый текст' }, ctx);
  expect(limited.matches).toHaveLength(100);
  expect(limited).toMatchObject({ incomplete: true, reason: 'match_limit' });
  await files.writeFile(path, Array(100).fill('Искомый текст').join('\n'));
  expect(await searchFiles({ path: '.', text: 'Искомый текст' }, ctx)).toMatchObject({
    incomplete: false,
    reason: null,
  });
});

it('запреты, зависимости, ссылки, большие и бинарные файлы исключаются без ложной ошибки доступа', async () => {
  const ctx = await context();
  ctx.config.tools.deniedPaths.push('private', 'private.txt');
  for (const name of ['node_modules', '.git', '.harness', '.tools', 'private']) {
    await files.mkdir(join(ctx.workspace, name));
    await files.writeFile(join(ctx.workspace, name, 'hidden.txt'), 'needle');
  }
  await files.writeFile(join(ctx.workspace, 'private.txt'), 'needle');
  await files.writeFile(join(ctx.workspace, 'binary'), 'needle\0');
  await files.writeFile(join(ctx.workspace, 'large'), 'needle' + 'x'.repeat(1048576));
  await files.writeFile(join(ctx.workspace, 'readme'), 'first\nneedle');
  await files.symlink(join(ctx.workspace, 'readme'), join(ctx.workspace, 'link'));
  expect(await searchFiles({ path: '.', text: 'needle' }, ctx)).toEqual({
    matches: [{ path: 'readme', line: 2, text: 'needle' }],
    visited: 3,
    scannedDirectories: 1,
    incomplete: false,
    reason: null,
  });
});

it.each(['file', 'directory'] as const)(
  'ошибка доступа к %s оставляет результат явно неполным',
  async (kind) => {
    const ctx = await context();
    await files.writeFile(join(ctx.workspace, 'readme'), 'needle');
    const path = join(ctx.workspace, 'unreadable');
    const denied = () => Object.assign(new Error('Доступ запрещён'), { code: 'EACCES' });
    if (kind === 'file') {
      await files.writeFile(path, 'needle');
      vi.mocked(files.readFile).mockImplementation(async (target, options) => {
        if (target === path) throw denied();
        return actual.readFile(target, options);
      });
    } else {
      await files.mkdir(path);
      vi.mocked(files.opendir).mockImplementation(async (target, options) => {
        if (target === path) throw denied();
        return actual.opendir(target, options);
      });
    }
    expect(await searchFiles({ path: '.', text: 'needle' }, ctx)).toMatchObject({
      matches: [{ path: 'readme', line: 1, text: 'needle' }],
      incomplete: true,
      reason: 'unreadable',
    });
  },
);

it('недоступный корень не выдаётся за полный поиск без совпадений', async () => {
  const ctx = await context();
  vi.mocked(files.realpath).mockRejectedValueOnce(
    Object.assign(new Error('Недоступна родительская папка'), { code: 'EACCES' }),
  );
  expect(await searchFiles({ path: '.', text: 'needle' }, ctx)).toMatchObject({
    matches: [],
    visited: 0,
    scannedDirectories: 0,
    incomplete: true,
    reason: 'unreadable',
  });
});

it('явно запрещённый корень поиска отклоняется прежней проверкой политики', async () => {
  const ctx = await context();
  await files.mkdir(join(ctx.workspace, 'private'));
  ctx.config.tools.deniedPaths.push('private');
  await expect(searchFiles({ path: 'private', text: 'needle' }, ctx)).rejects.toThrow(
    'Path denied by policy',
  );
});

it.each(['list', 'search'] as const)('отменённый %s не начинает обход', async (kind) => {
  const controller = new AbortController();
  const ctx = await context(controller.signal);
  controller.abort();
  const operation =
    kind === 'list'
      ? listDirectory({ path: '.' }, ctx)
      : searchFiles({ path: '.', text: 'needle' }, ctx);
  await expect(operation).rejects.toThrow('CANCELLED');
  expect(files.readdir).not.toHaveBeenCalled();
  expect(files.opendir).not.toHaveBeenCalled();
});

it('список учитывает отмену, пришедшую во время чтения каталога', async () => {
  const controller = new AbortController();
  const ctx = await context(controller.signal);
  vi.mocked(files.readdir).mockImplementationOnce(async (path, options) => {
    const entries = await actual.readdir(path, options);
    controller.abort();
    return entries;
  });
  await expect(listDirectory({ path: '.' }, ctx)).rejects.toThrow('CANCELLED');
});

it('отмена поиска закрывает открытый каталог и не возвращает успешный пустой результат', async () => {
  const controller = new AbortController();
  const ctx = await context(controller.signal);
  await files.writeFile(join(ctx.workspace, 'readme'), 'needle');
  let opened: Dir | undefined;
  vi.mocked(files.opendir).mockImplementationOnce(async (path, options) => {
    opened = await actual.opendir(path, options);
    controller.abort();
    return opened;
  });
  await expect(searchFiles({ path: '.', text: 'needle' }, ctx)).rejects.toThrow('CANCELLED');
  expect(opened).toBeDefined();
  await expect(opened!.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
});
