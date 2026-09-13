import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, symlink, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { FileChanges } from '../src/tools/file-changes.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { fileCommand } from '../src/interfaces/file-routes.js';
import type { Application } from '../src/interfaces/application.js';
import { call, eventually, harness, output, ScriptedProvider, temporary } from './helpers.js';

async function written(existing = true) {
  const app = await harness(
    new ScriptedProvider((_request, index) =>
      index === 0
        ? output('', [call('write', 'fs.write', { path: 'Файл.txt', content: 'Новый текст\n' })])
        : output('Готово'),
    ),
  );
  const path = join(app.workspace, 'Файл.txt');
  if (existing) await writeFile(path, 'Прежний текст\n');
  const { runId } = await app.runtime.start({
    message: 'Запиши',
    workspace: app.workspace,
    requestKey: randomUUID(),
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('completed');
  return { ...app, path, runId, changeId: app.sessions.get(runId).fileChanges![0]!.id };
}
it('показывает diff и восстанавливает точные байты после перезапуска хранилища', async () => {
  const app = await written();
  const sessions = new FileSessionStore(app.sessions.directory);
  await sessions.initialize();
  const files = new FileChanges(sessions);
  const preview = await files.previewRestore(app.runId, app.changeId);
  expect(preview.diff).toContain('-Новый текст');
  expect(preview.diff).toContain('+Прежний текст');
  await files.restore(app.runId, app.changeId, preview.previewToken);
  expect(await readFile(app.path, 'utf8')).toBe('Прежний текст\n');
  await expect(files.restore(app.runId, app.changeId, preview.previewToken)).rejects.toThrow(
    'нельзя',
  );
  expect(
    sessions.get(app.runId).agents[sessions.get(app.runId).rootAgentId]!.messages.at(-1)?.content,
  ).toContain('восстановил');
});
it('восстановление созданного файла удаляет его; сторонние правки сохраняются', async () => {
  const created = await written(false),
    files = new FileChanges(created.sessions);
  const preview = await files.previewRestore(created.runId, created.changeId);
  await files.restore(created.runId, created.changeId, preview.previewToken);
  await expect(readFile(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
  const edited = await written(),
    other = new FileChanges(edited.sessions);
  const old = await other.previewRestore(edited.runId, edited.changeId);
  await writeFile(edited.path, 'Правки человека');
  await expect(other.restore(edited.runId, edited.changeId, old.previewToken)).rejects.toThrow(
    'изменён',
  );
  expect(await readFile(edited.path, 'utf8')).toBe('Правки человека');
});
it('отклоняет запись по устаревшему предпросмотру разрешения', async () => {
  const app = await harness(
    new ScriptedProvider((_request, index) =>
      index === 0
        ? output('', [call('write', 'fs.write', { path: 'Файл.txt', content: 'Замена' })])
        : output('Операция обработана'),
    ),
    (config) => {
      config.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
    },
  );
  const path = join(app.workspace, 'Файл.txt');
  await writeFile(path, 'Исходник');
  const { runId } = await app.runtime.start({
    message: 'Запиши',
    workspace: app.workspace,
    requestKey: randomUUID(),
  });
  await eventually(() => app.approvals.pending().length === 1);
  const approval = app.approvals.pending()[0]!,
    files = new FileChanges(app.sessions);
  const preview = await files.previewApproval(approval.id);
  expect(preview.diff).toContain('-Исходник');
  await writeFile(path, 'Внешняя правка');
  await app.approvals.resolve(approval.id, true, preview.previewToken);
  await app.runtime.wait(runId);
  expect(await readFile(path, 'utf8')).toBe('Внешняя правка');
  expect(Object.values(app.sessions.get(runId).invocations)[0]?.status).toBe('error');
});
it('не восстанавливает файл через подменённую символическую ссылку', async () => {
  if (process.platform === 'win32') return;
  const app = await written();
  const outside = join(await temporary(), 'outside.txt');
  await writeFile(outside, 'Внешний файл');
  const { unlink } = await import('node:fs/promises');
  await unlink(app.path);
  await symlink(outside, app.path);
  await expect(
    new FileChanges(app.sessions).previewRestore(app.runId, app.changeId),
  ).rejects.toThrow('outside');
  expect(await readFile(outside, 'utf8')).toBe('Внешний файл');
});

it.each([true, false])(
  'восстановление existing=%s отвергает подмену пути после записи начала операции',
  async (existing) => {
    if (process.platform === 'win32') return;
    const app = await written(existing);
    const neighbor = join(app.workspace, 'Соседний.txt');
    const displaced = join(app.workspace, 'Перемещённый.txt');
    const content = await readFile(app.path, 'utf8');
    await writeFile(neighbor, content);
    const preview = await new FileChanges(app.sessions).previewRestore(app.runId, app.changeId);
    const mutate = app.sessions.mutate.bind(app.sessions);
    vi.spyOn(app.sessions, 'mutate').mockImplementation(async (runId, type, payload, update) => {
      const state = await mutate(runId, type, payload, update);
      if (type === 'file.restore_started') {
        await rename(app.path, displaced);
        await symlink(neighbor, app.path);
      }
      return state;
    });
    const channel = {
      sessions: app.sessions,
      runtime: app.runtime,
      scheduler: new ToolScheduler(1),
    } as Application;
    await expect(
      fileCommand(channel, 'files.restore', {
        runId: app.runId,
        changeId: app.changeId,
        previewToken: preview.previewToken,
      }),
    ).rejects.toThrow('Путь к файлу изменился');
    expect(await readFile(neighbor, 'utf8')).toBe(content);
    expect(await readFile(displaced, 'utf8')).toBe(content);
    expect((await lstat(app.path)).isSymbolicLink()).toBe(true);
    expect(app.sessions.get(app.runId).fileChanges![0]!.status).not.toBe('restored');
  },
);
