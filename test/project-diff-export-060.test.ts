import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as contentFiles from '../src/application/project-export-diff.js';
import { createApplication } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import { parseCommandInput, parseCommandResponse } from '../src/interfaces/contracts/index.js';
import { configDirectory, temporary, cleanup, ScriptedProvider } from './helpers.js';
import { mutation } from './project-helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Доказательства создаются без модели и без изменения настоящих пользовательских проектов. */
async function fixture() {
  const root = await temporary();
  const configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  await writeFile(
    join(dirname(configFile), 'policy.json'),
    JSON.stringify({ default: 'deny', rules: [{ tool: '*', decision: 'allow' }] }),
  );
  const app = await createApplication(
    configFile,
    join(root, 'state'),
    new ScriptedProvider(() => {
      throw new Error('Модель не нужна');
    }),
  );
  cleanup(() => app.close());
  const folder = join(root, 'workspace');
  let view = await app.projects.create({
    title: 'Экспорт diff',
    goal: 'Показать изменения',
    workspace: folder,
    profile: 'test',
    requestKey: 'create',
  });
  view = await app.projects.cancel(mutation(view));
  const record = await app.projects.store.get(view.projectId);
  const workspace = app.projects.coordinator.options.workspace;
  const options = { settings: record.capture!, config: record.config.value };
  await writeFile(join(folder, 'example.ts'), 'let value = 1;\n');
  const before = await workspace.capture(record.id, folder, [], options);
  await writeFile(join(folder, 'example.ts'), 'let value = 2;\n' + '// ```literal fence\n');
  const after = await workspace.capture(record.id, folder, [], options);
  record.changeSets = [
    { id: 'overall', kind: 'project', outcome: 'complete', planVersion: 0, before, after },
  ];
  const saved = await app.projects.store.save(
    record,
    record.revision,
    'test.snapshots',
    'Контрольные точки',
  );
  return {
    root,
    app,
    folder,
    project: saved,
    input: { projectId: saved.id, expectedRevision: saved.revision },
  };
}

it.each(['json', 'markdown'] as const)(
  'экспорт %s включает diff только по выбору и повторно возвращает тот же файл',
  async (format) => {
    const item = await fixture();
    const without = await item.app.projectExports.preview({ ...item.input, format });
    expect(without).not.toHaveProperty('includeDiffs');
    const plain = await item.app.projectExports.export({
      ...item.input,
      format,
      previewToken: without.previewToken,
      requestKey: 'without',
    });
    expect(await readFile(plain.path, 'utf8')).not.toContain('let value = 2');
    const preview = await item.app.projectExports.preview({
      ...item.input,
      format,
      includeDiffs: true,
    });
    expect(preview.diffs).toMatchObject({ files: 1, unavailable: 0 });
    expect(preview.warnings.some((warning) => warning.includes('исходный код'))).toBe(true);
    const request = {
      ...item.input,
      format,
      includeDiffs: true,
      previewToken: preview.previewToken,
      requestKey: 'with-diff',
    };
    const result = await item.app.projectExports.export(request);
    expect(await item.app.projectExports.export(request)).toEqual(result);
    const raw = await readFile(result.path, 'utf8');
    expect(raw).toContain('+let value = 2;');
    expect(raw).not.toContain('basePrompt');
    expect(raw).not.toContain('apiKeyEnv');
    if (format === 'json') {
      const parsed = JSON.parse(raw);
      expect(parsed.diffs[0].text).toContain('// ```literal fence');
      expect(parsed.diffs[0].path).toBe('example.ts');
    }
  },
);

it('сбой или изменение копии после предпросмотра не публикует частичный diff', async () => {
  const item = await fixture();
  const preview = await item.app.projectExports.preview({ ...item.input, includeDiffs: true });
  const manifest =
    await item.app.projects.coordinator.options.workspace.content.readContentManifest(
      item.project.id,
      item.project.changeSets![0]!.after!.contentRef!,
    );
  const path = join(
    item.app.directory,
    'project-content',
    item.project.id,
    'blobs',
    manifest.entries[0]!.digest,
  );
  await writeFile(path, 'подмена');
  await expect(
    item.app.projectExports.export({
      ...item.input,
      includeDiffs: true,
      previewToken: preview.previewToken,
      requestKey: 'tampered',
    }),
  ).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  const names = await readdir(join(item.app.directory, 'exports', 'projects', item.project.id));
  expect(names).toEqual([]);
});

it('полное удаление охватывает исходники, временные копии, экспорт и LRU; внешняя копия остаётся', async () => {
  const item = await fixture();
  const preview = await item.app.projectExports.preview({ ...item.input, includeDiffs: true });
  const report = await item.app.projectExports.export({
    ...item.input,
    includeDiffs: true,
    previewToken: preview.previewToken,
    requestKey: 'export',
  });
  const copy = join(item.folder, 'copied.md');
  await writeFile(copy, await readFile(report.path));
  const owned = join(item.app.directory, 'project-content', item.project.id);
  await writeFile(join(owned, 'orphan.tmp'), 'после аварии');
  expect(item.app.projectChanges.worker.stats().bytes).toBeGreaterThan(0);
  const removal = await item.app.projects.purgePreview({ projectId: item.project.id });
  expect(removal.available).toBe(true);
  await item.app.projects.purge({
    projectId: item.project.id,
    expectedRevision: item.project.revision,
    requestKey: 'remove',
    previewToken: removal.previewToken,
  });
  await expect(readFile(report.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readdir(owned)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(item.app.projectChanges.worker.stats().bytes).toBe(0);
  expect(await readFile(copy, 'utf8')).toContain('+let value = 2;');
});

it.each(['tasks', 'learning'] as const)(
  'сброс %s учитывает только выбранную область данных',
  async (scope) => {
    const item = await fixture();
    const owned = join(item.app.directory, 'project-content', item.project.id);
    const preview = await item.app.reset.preview(scope);
    expect(preview.available).toBe(true);
    await item.app.reset.reset(scope, preview.previewToken);
    if (scope === 'learning') expect((await readdir(owned)).length).toBeGreaterThan(0);
    else await expect(readdir(owned)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('новые локальные read-команды работают в диагностике и старые запросы не получают includeDiffs', async () => {
  const item = await fixture();
  expect(parseCommandInput('projects.exportPreview', item.input)).not.toHaveProperty(
    'includeDiffs',
  );
  const info = parseCommandResponse('system.info', await dispatch(item.app, 'system.info', {}));
  expect(info.capabilities).toContain('projects-diff-v1');
  item.app.sessions.requireRecovery('отказ хранения');
  const list = parseCommandResponse(
    'projects.changeSets',
    await dispatch(item.app, 'projects.changeSets', { projectId: item.project.id }),
  );
  expect(list.items[0]?.id).toBe('overall');
  await expect(
    dispatch(item.app, 'projects.changeCapture', {
      ...item.input,
      requestKey: 'toggle',
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});

it('потоковая запись проверяет digest после последней страницы до публикации', async () => {
  const item = await fixture();
  const prepared = await contentFiles.prepareExportDiffs(item.app.projectChanges, item.project.id);
  const chunks = contentFiles.exportDiffChunks(
    item.app.projectChanges,
    item.project.id,
    '0'.repeat(64),
    'json',
  );
  const digest = createHash('sha256');
  await expect(
    (async () => {
      for await (const chunk of chunks) digest.update(chunk);
    })(),
  ).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  expect(prepared.digest).not.toBe('0'.repeat(64));
});
