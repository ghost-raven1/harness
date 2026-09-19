import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { ProjectChangeService } from '../src/projects/change-service.js';
import { ProjectDiffWorker } from '../src/projects/change-worker.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';
import { projectChangeInputs } from '../src/projects/change-schema.js';
import type { ProjectChangeSet } from '../src/projects/change-types.js';
import { resolveCaptureSettings } from '../src/configuration/project-capture.js';
import { cleanup, fixtureConfig, temporary } from './helpers.js';

/** Настоящие манифесты и worker проверяются отдельно от исполнителей проекта. */
async function fixture(before: string, after: string, historical = false) {
  const root = await temporary();
  const folder = join(root, 'workspace');
  const state = join(root, 'state');
  await mkdir(folder);
  const workspace = new ProjectWorkspace(state);
  const options = historical
    ? undefined
    : { settings: resolveCaptureSettings(), config: fixtureConfig(folder) };
  await writeFile(join(folder, 'пример.ts'), before);
  const first = await workspace.capture('project-1', folder, [], options);
  await writeFile(join(folder, 'пример.ts'), after);
  const second = await workspace.capture('project-1', folder, [], options);
  const interval: ProjectChangeSet = {
    id: 'interval-1',
    kind: 'project',
    outcome: 'complete',
    planVersion: 1,
    before: first,
    after: second,
  };
  const project = {
    id: 'project-1',
    revision: 4,
    changeSets: [interval],
    deletedAt: undefined as string | undefined,
  };
  const reader = vi.fn(async () => project);
  const service = new ProjectChangeService({
    readProject: reader,
    content: workspace.content,
    workspace,
  });
  cleanup(() => service.close());
  const request = { projectId: project.id, changeSetId: interval.id };
  const list = await service.changes(request);
  return {
    root,
    state,
    folder,
    workspace,
    project,
    interval,
    reader,
    service,
    request,
    file: list.items[0]!,
  };
}

it('читает точный Unicode, CRLF и отсутствие завершающей строки страницами без обращения к рабочей папке', async () => {
  const expected = 'a'.repeat(16_383) + '🐦\r\nизменено';
  const test = await fixture('до\r\nнет перевода', expected);
  await writeFile(join(test.folder, 'пример.ts'), 'чужие новые данные');
  const first = await test.service.fileChange({
    ...test.request,
    fileId: test.file.fileId,
    view: 'after',
  });
  expect(first.text.length).toBe(16_383);
  expect(first.nextOffset).toBe(16_383);
  const second = await test.service.fileChange({
    ...test.request,
    fileId: test.file.fileId,
    view: 'after',
    offset: first.nextOffset,
  });
  expect(first.text + second.text).toBe(expected);
  const patch = await test.service.fileChange({
    ...test.request,
    fileId: test.file.fileId,
    view: 'diff',
  });
  expect(patch.state).toBe('available');
  expect(patch.text).toContain('до/пример.ts');
  expect(patch.text).toContain('-нет перевода');
  expect(await readFile(join(test.folder, 'пример.ts'), 'utf8')).toBe('чужие новые данные');
});

it('запрещает чужие проект, интервал, файл и манифест вместо выбранной точки', async () => {
  const test = await fixture('before', 'after');
  await expect(test.service.changeSets({ projectId: 'foreign' })).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  await expect(
    test.service.changes({ ...test.request, changeSetId: 'foreign' }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  await expect(
    test.service.fileChange({ ...test.request, fileId: 'foreign', view: 'diff' }),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  test.interval.after!.contentRef = test.interval.before.contentRef;
  await expect(test.service.changes(test.request)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
});

it('исторические хеши сохраняют список изменений, но не подменяют отсутствующий текст текущим файлом', async () => {
  const test = await fixture('старое', 'новое', true);
  expect(test.file.before?.reason).toContain('не сохранялся');
  const output = await test.service.fileChange({
    ...test.request,
    fileId: test.file.fileId,
    view: 'before',
  });
  expect(output.state).toBe('unavailable');
  expect(output.text).toBe('');
});

it('удалённая копия не возвращается из LRU и удаление проекта очищает память', async () => {
  const test = await fixture('старое', 'новое');
  const input = { ...test.request, fileId: test.file.fileId, view: 'diff' as const };
  expect((await test.service.fileChange(input)).state).toBe('available');
  const firstBytes = test.service.worker.stats().bytes;
  expect((await test.service.fileChange(input)).state).toBe('available');
  expect(test.service.worker.stats().bytes).toBe(firstBytes);
  const manifest = await test.workspace.content.readContentManifest(
    test.project.id,
    test.interval.after!.contentRef!,
  );
  await rm(
    join(test.state, 'project-content', test.project.id, 'blobs', manifest.entries[0]!.digest),
  );
  expect((await test.service.fileChange(input)).state).toBe('unavailable');
  test.service.forget(test.project.id);
  expect(test.service.worker.stats().bytes).toBe(0);
  test.project.deletedAt = new Date().toISOString();
  await expect(test.service.fileChange(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});

it('показывает выполняющийся интервал и окончательный результат по тому же устойчивому ID', async () => {
  const test = await fixture('до', 'после');
  const after = test.interval.after;
  test.interval.outcome = 'pending';
  test.interval.after = undefined;
  const pending = await test.service.changes(test.request);
  expect(pending.interval?.outcome).toBe('pending');
  expect(pending.items).toEqual([]);
  test.interval.outcome = 'complete';
  test.interval.after = after;
  const completed = await test.service.changes(test.request);
  expect(completed.interval?.outcome).toBe('complete');
  expect(completed.items).toHaveLength(1);
  const manifestRead = vi.spyOn(test.workspace.content, 'readContentManifest');
  await test.service.changeSets({ projectId: test.project.id });
  expect(manifestRead).not.toHaveBeenCalled();
});

it('добавленные и удалённые файлы имеют пустую отсутствующую сторону; права отличимы от текста', async () => {
  const test = await fixture('до', 'после');
  await writeFile(join(test.folder, 'новый.txt'), 'new');
  await rm(join(test.folder, 'пример.ts'));
  test.interval.after = await test.workspace.capture(test.project.id, test.folder, [], {
    settings: resolveCaptureSettings(),
    config: fixtureConfig(test.folder),
  });
  const result = await test.service.changes(test.request);
  expect(result.items.map((item) => item.kind).sort()).toEqual(['added', 'deleted']);
  const added = result.items.find((item) => item.kind === 'added')!;
  const before = await test.service.fileChange({
    ...test.request,
    fileId: added.fileId,
    view: 'before',
  });
  expect(before.state).toBe('available');
  expect(before.text).toBe('');
  if (process.platform !== 'win32') {
    test.interval.before = test.interval.after;
    await chmod(join(test.folder, 'новый.txt'), 0o755);
    test.interval.after = await test.workspace.capture(test.project.id, test.folder, [], {
      settings: resolveCaptureSettings(),
      config: fixtureConfig(test.folder),
    });
    expect((await test.service.changes(test.request)).items[0]?.executableChanged).toBe(true);
  }
});

it('лимит сложного diff сохраняет вкладку полного текста и не блокирует event loop', async () => {
  const test = await fixture(
    Array.from({ length: 12_000 }, (_, index) => 'старое' + index).join('\n'),
    Array.from({ length: 12_000 }, (_, index) => 'новое' + index).join('\n'),
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const diff = await test.service.fileChange({
      ...test.request,
      fileId: test.file.fileId,
      view: 'diff',
    });
    expect(diff.state).toBe('limited');
    expect(ticks).toBeGreaterThan(1);
    expect(
      (await test.service.fileChange({ ...test.request, fileId: test.file.fileId, view: 'after' }))
        .state,
    ).toBe('available');
  } finally {
    clearInterval(timer);
  }
});

it('очередь объединяет запросы, отклоняет лишние без чтения и очищает ожидающие при удалении', async () => {
  const worker = new ProjectDiffWorker();
  cleanup(() => worker.close());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = vi.fn(async () => {
    await blocked;
    return { before: 'до', after: 'после' };
  });
  const first = worker.compute('p', 'same', 'file.ts', load);
  const duplicate = worker.compute('p', 'same', 'file.ts', load);
  expect(duplicate).toBe(first);
  const queue = Array.from({ length: 7 }, (_, index) =>
    worker.compute('p', String(index), 'file.ts', load),
  );
  const excess = await worker.compute('p', 'excess', 'file.ts', load);
  expect(excess.state).toBe('limited');
  expect(load).toHaveBeenCalledTimes(1);
  worker.forget('p');
  release();
  expect((await first).state).toBe('limited');
  expect((await Promise.all(queue)).every((item) => item.state === 'limited')).toBe(true);
  expect(worker.stats()).toMatchObject({ bytes: 0, pending: 0 });
});

it('контракты не принимают путь артефакта и не ограничивают старые запросы дополнительными полями', () => {
  expect(
    projectChangeInputs.fileChange.safeParse({
      projectId: 'p',
      changeSetId: 'c',
      fileId: 'f',
      view: 'diff',
      path: '/secret',
    }).success,
  ).toBe(false);
  expect(
    projectChangeInputs.changeCapture.parse({
      projectId: 'p',
      expectedRevision: 0,
      requestKey: 'k',
      enabled: false,
    }),
  ).toMatchObject({ enabled: false });
});

it('LRU вытесняет большие diff и сохраняет предел 16 МиБ после повторных чтений', async () => {
  const worker = new ProjectDiffWorker();
  cleanup(() => worker.close());
  const text = 'т'.repeat(1024 * 1024);
  for (let index = 0; index < 6; index++) {
    const result = await worker.compute('large', String(index), 'large.ts', async () => ({
      before: text + index,
      after: text + (index + 1),
    }));
    expect(result.state).toBe('available');
    expect(worker.stats().bytes).toBeLessThanOrEqual(worker.stats().maximumBytes);
  }
  expect(worker.stats().entries).toBeLessThan(6);
  const before = worker.stats().bytes;
  await worker.compute('large', '5', 'large.ts', async () => ({
    before: text + '5',
    after: text + '6',
  }));
  expect(worker.stats().bytes).toBeLessThanOrEqual(before);
  worker.forget('large');
  expect(worker.stats().bytes).toBe(0);
});

it('закрытие активного worker освобождает очередь и не отдаёт удалённый текст', async () => {
  const worker = new ProjectDiffWorker();
  const first = worker.compute('closing', 'first', 'large.ts', async () => ({
    before: Array.from({ length: 12_000 }, (_, index) => 'до' + index).join('\n'),
    after: Array.from({ length: 12_000 }, (_, index) => 'после' + index).join('\n'),
  }));
  const queued = worker.compute('closing', 'queued', 'small.ts', async () => ({
    before: 'a',
    after: 'b',
  }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker.close();
  expect((await first).state).toBe('limited');
  expect((await queued).state).toBe('limited');
  expect(worker.stats()).toMatchObject({ bytes: 0, pending: 0 });
});

it('удаление проекта во время чтения остаётся ошибкой отсутствующей записи', async () => {
  const test = await fixture('до', 'после');
  test.reader
    .mockResolvedValueOnce(test.project)
    .mockRejectedValueOnce(new ResourceNotFoundError('project'));
  await expect(
    test.service.fileChange({ ...test.request, fileId: test.file.fileId, view: 'after' }),
  ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', resource: 'project' });
});
