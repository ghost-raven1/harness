import { expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { join } from 'node:path';
import { FileChanges } from '../src/tools/file-changes.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');

it('частично выполненный откат сохраняет неопределённый исход и не разрешает повтор', async () => {
  const app = await harness(
    new ScriptedProvider((_, index) =>
      index === 0
        ? output('', [call('write', 'fs.write', { path: 'result.txt', content: 'Новая версия' })])
        : output('Готово'),
    ),
  );
  const path = join(app.workspace, 'result.txt');
  await files.writeFile(path, 'Прежняя версия');
  const { runId } = await app.runtime.start({
    message: 'Обнови файл',
    workspace: app.workspace,
    requestKey: 'restore-write-failure',
  });
  await app.runtime.wait(runId);
  const changes = new FileChanges(app.sessions);
  const changeId = app.sessions.get(runId).fileChanges![0]!.id;
  const preview = await changes.previewRestore(runId, changeId);
  vi.mocked(files.writeFile).mockImplementationOnce(async () => {
    await actual.writeFile(path, 'Прежняя');
    throw new Error('Запись оборвалась после изменения файла');
  });
  await expect(changes.restore(runId, changeId, preview.previewToken)).rejects.toThrow(
    'Запись оборвалась',
  );
  expect(app.sessions.get(runId).fileChanges![0]!.status).toBe('restoring');
  const recovered = new FileSessionStore(app.sessions.directory);
  await recovered.initialize();
  const restoredChanges = new FileChanges(recovered);
  await expect(restoredChanges.restore(runId, changeId, preview.previewToken)).rejects.toThrow(
    'Неизвестный исход',
  );
  expect(await files.readFile(path, 'utf8')).toBe('Прежняя');
});
