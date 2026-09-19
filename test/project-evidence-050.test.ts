import * as files from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectEvidenceService } from '../src/projects/evidence.js';
import { EvidenceCache, maximumEvidenceBytes } from '../src/projects/evidence-cache.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { ProjectExportService } from '../src/application/project-export.js';
import {
  projectHarness,
  draftProject,
  mutation,
  waitProject,
  stagePlan,
} from './project-helpers.js';
import { id } from '../src/shared/primitives.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, link: vi.fn(actual.link) };
});

/** Стенд проводит настоящий проект через три набора детерминированных проверок. */
async function ready(stdout = 'Успех', stderr = '', truncated = false) {
  const app = await projectHarness();
  app.registry.get('process.exec').execute = async () => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: truncated,
    stderrTruncated: false,
  });
  const draft = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(draft), expectedPlanVersion: draft.planVersion! });
  const view = await waitProject(app, draft.projectId, 'review');
  const evidence = new ProjectEvidenceService({
    projects: app.projectStore,
    sessions: app.sessions,
    workspace: new ProjectWorkspace(app.sessions.directory),
  });
  const exports = new ProjectExportService({
    directory: app.sessions.directory,
    projects: app.projectStore,
    evidence,
    serialize: (work) => app.coordinator.serial.run(work),
    assertWritable: () => app.sessions.assertWritable(),
  });
  return { ...app, view, evidence, exports };
}
afterEach(() => vi.restoreAllMocks());

describe('доказательства проекта 0.5', () => {
  it('читает ошибку за 1500 символами, весь сохранённый вывод, Unicode и отдельный stderr', async () => {
    const stdout = 'x'.repeat(16383) + '😀' + 'ю'.repeat(9000) + '\u001b[31mконец';
    const app = await ready(stdout, 'x'.repeat(1800) + 'ВАЖНО: ошибка', true);
    const reports = await app.evidence.reports({ projectId: app.view.projectId });
    const report = reports.items.at(-1)!;
    const input = {
      projectId: app.view.projectId,
      reportId: report.id,
      checkId: report.checks[0]!.id,
      stream: 'stdout' as const,
    };
    const first = await app.evidence.checkOutput(input);
    expect(first.text).toHaveLength(16383);
    expect(first.truncated).toBe(true);
    const second = await app.evidence.checkOutput({ ...input, offset: first.nextOffset });
    expect(first.text + second.text).toBe(stdout);
    expect(second.complete).toBe(false);
    const error = await app.evidence.checkOutput({ ...input, stream: 'stderr' });
    expect(error.text).toContain('ВАЖНО: ошибка');
    expect(error.complete).toBe(true);
  });

  it('просмотр приёмки не пишет снимки, а новые файлы делают доказательства устаревшими', async () => {
    const app = await ready();
    const folder = join(app.sessions.directory, 'project-artifacts', app.view.projectId);
    const before = await readdir(folder);
    const review = await app.evidence.review({ projectId: app.view.projectId });
    expect(review.canAccept).toBe(true);
    expect(review.stages[0]!.confirmed).toBe(true);
    expect(await readdir(folder)).toEqual(before);
    await writeFile(join(app.workspace, 'changed.ts'), 'external edit');
    expect((await app.evidence.review({ projectId: app.view.projectId })).freshness).toBe(
      'changed',
    );
    await expect(
      app.evidence.validateAccept(await app.projectStore.get(app.view.projectId)),
    ).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(await readdir(folder)).toEqual(before);
  });

  it('не принимает исчезнувший артефакт, в том числе после прогрева кэша', async () => {
    const app = await ready('a'.repeat(50000));
    const project = await app.projectStore.get(app.view.projectId);
    const final = project.reports.at(-1)!;
    expect((await app.evidence.review({ projectId: project.id })).canAccept).toBe(true);
    expect(app.evidence.cacheStats().bytes).toBeGreaterThan(0);
    await rm(
      join(
        app.sessions.directory,
        'artifacts',
        final.runId!,
        final.checks[0]!.artifactId! + '.txt',
      ),
    );
    const review = await app.evidence.review({ projectId: project.id });
    expect(review.canAccept).toBe(false);
    expect(review.reports.at(-1)!.checks[0]!.evidence).toBe('unavailable');
    app.evidence.forget(project.id);
    expect(app.evidence.cacheStats().bytes).toBe(0);
  });

  it('слишком большой исходный артефакт отклоняется до загрузки содержимого', async () => {
    const app = await ready('a'.repeat(50000));
    const project = await app.projectStore.get(app.view.projectId);
    const report = project.reports.at(-1)!;
    await files.truncate(
      join(
        app.sessions.directory,
        'artifacts',
        report.runId!,
        report.checks[0]!.artifactId! + '.txt',
      ),
      maximumEvidenceBytes + 1,
    );
    const read = vi.spyOn(app.sessions, 'readOwnedArtifact');
    expect(
      (await app.evidence.readCheck(project, report, report.checks[0]!.id)).check.evidence,
    ).toBe('unavailable');
    expect(read).not.toHaveBeenCalled();
  });

  it('отклоняет чужую цепочку вызова и артефакта', async () => {
    const app = await ready('z'.repeat(50000));
    const project = await app.projectStore.get(app.view.projectId);
    const report = project.reports.at(-1)!;
    const alien = { ...report, checks: [{ ...report.checks[0]!, artifactId: id() }] };
    expect((await app.evidence.readCheck(project, alien, alien.checks[0]!.id)).check.evidence).toBe(
      'unavailable',
    );
    const wrongProject = { ...project, id: id() };
    expect(
      (await app.evidence.readCheck(wrongProject, report, report.checks[0]!.id)).check.evidence,
    ).toBe('unavailable');
  });

  it('подтверждает ручной этап только сохранённым решением человека', async () => {
    const app = await projectHarness();
    const plan = stagePlan();
    plan.stages[0]!.verification = { kind: 'manual', instructions: 'Посмотреть результат глазами' };
    const draft = await draftProject(app, plan);
    await app.projects.acceptPlan({ ...mutation(draft), expectedPlanVersion: draft.planVersion! });
    const paused = await waitProject(app, draft.projectId, 'paused');
    const evidence = new ProjectEvidenceService({
      projects: app.projectStore,
      sessions: app.sessions,
      workspace: new ProjectWorkspace(app.sessions.directory),
    });
    expect((await evidence.review({ projectId: draft.projectId })).canAccept).toBe(false);
    await app.projects.manualCheck({
      ...mutation(paused),
      stageId: 'implement',
      expectedResultRevision: paused.resultRevision!,
      outcome: 'passed',
      comment: 'Проверил вручную',
    });
    const review = await waitProject(app, draft.projectId, 'review');
    expect((await evidence.review({ projectId: draft.projectId })).canAccept).toBe(true);
    expect((await evidence.review({ projectId: draft.projectId })).stages[0]!.confirmed).toBe(true);
    app.projects.verifyAcceptance = (project) => evidence.validateAccept(project);
    expect(
      (
        await app.projects.accept({
          ...mutation(review),
          expectedResultRevision: review.resultRevision!,
        })
      ).status,
    ).toBe('completed');
  });

  it('новая версия сохраняет доказательства завершённого этапа и проверяет новые итоги', async () => {
    const app = await ready();
    const plan = stagePlan();
    plan.stages.push({
      ...plan.stages[0]!,
      id: 'follow-up',
      title: 'Дополнительный этап',
      dependsOn: ['implement'],
    });
    const edited = await app.projects.editPlan({ ...mutation(app.view), plan });
    await app.projects.acceptPlan({
      ...mutation(edited),
      expectedPlanVersion: edited.planVersion!,
    });
    const view = await waitProject(app, edited.projectId, 'review');
    const review = await app.evidence.review({ projectId: view.projectId });
    expect(review.canAccept).toBe(true);
    expect(review.stages[0]).toMatchObject({ confirmed: true, inheritedEvidence: true });
    expect(review.reports.some((report) => !report.current && report.phase === 'stage')).toBe(true);
  });

  it('экспортирует оба формата, опциональные журналы и возвращает тот же файл по ключу', async () => {
    const app = await ready('private stdout', 'private stderr');
    for (const format of ['markdown', 'json'] as const) {
      for (const includeLogs of [false, true]) {
        const input = {
          projectId: app.view.projectId,
          expectedRevision: app.view.revision,
          format,
          includeLogs,
        };
        const preview = await app.exports.preview(input);
        const request = { ...input, previewToken: preview.previewToken, requestKey: id() };
        const result = await app.exports.export(request);
        expect(result.path).toContain(join('exports', 'projects', app.view.projectId));
        const content = await readFile(result.path, 'utf8');
        if (format === 'json') expect(JSON.parse(content).reports).toHaveLength(3);
        expect(content.includes('private stdout')).toBe(includeLogs);
        expect(content.includes('private stderr')).toBe(includeLogs);
        expect(content).not.toContain('apiKeyEnv');
        expect(await app.exports.export(request)).toEqual(result);
        await writeFile(result.path, 'не перезаписывать');
        await expect(app.exports.export(request)).rejects.toMatchObject({
          code: 'STORAGE_UNAVAILABLE',
        });
        expect(await readFile(result.path, 'utf8')).toBe('не перезаписывать');
      }
    }
  });

  it('сбой публикации после записи намерения повторяет тот же экспорт после изменения проекта', async () => {
    const app = await ready();
    const input = { projectId: app.view.projectId, expectedRevision: app.view.revision };
    const preview = await app.exports.preview(input);
    const request = { ...input, previewToken: preview.previewToken, requestKey: id() };
    vi.mocked(files.link).mockRejectedValueOnce(
      Object.assign(new Error('Диск заполнен'), { code: 'ENOSPC' }),
    );
    await expect(app.exports.export(request)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await app.projects.archive({ ...mutation(app.view), archived: true });
    const restored = new ProjectExportService({
      directory: app.sessions.directory,
      projects: app.projectStore,
      evidence: app.evidence,
      serialize: (work) => app.coordinator.serial.run(work),
      assertWritable: () => app.sessions.assertWritable(),
    });
    const result = await restored.export(request);
    expect(result.revision).toBe(app.view.revision);
    expect(await readFile(result.path, 'utf8')).toContain('Проверяем результат разработки.');
    expect(await restored.export(request)).toEqual(result);
  });

  it('отклоняет экспорт после смены ревизии и изменения файлов', async () => {
    const app = await ready();
    const input = { projectId: app.view.projectId, expectedRevision: app.view.revision };
    const preview = await app.exports.preview(input);
    await writeFile(join(app.workspace, 'new.txt'), 'changed');
    await expect(
      app.exports.export({ ...input, previewToken: preview.previewToken, requestKey: id() }),
    ).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    const fresh = await app.exports.preview(input);
    await app.projects.archive({ ...mutation(app.view), archived: true });
    await expect(
      app.exports.export({ ...input, previewToken: fresh.previewToken, requestKey: id() }),
    ).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  });
});

describe('ограниченный кэш доказательств', () => {
  it('объединяет одновременное чтение и не превышает 16 МиБ', async () => {
    const cache = new EvidenceCache();
    const read = vi.fn(async () =>
      JSON.stringify({ stdout: 'a'.repeat(1048576), stderr: 'b'.repeat(1048576), exitCode: 0 }),
    );
    await Promise.all([cache.get('one', 'same', read), cache.get('one', 'same', read)]);
    expect(read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 9; i++) await cache.get('one', String(i), read);
    expect(cache.stats().bytes).toBeLessThanOrEqual(maximumEvidenceBytes);
    expect(cache.stats().entries).toBeLessThan(4);
    await expect(
      cache.get('one', 'huge', async () => ' '.repeat(maximumEvidenceBytes + 1)),
    ).rejects.toThrow('16 МиБ');
    cache.forget('one');
    expect(cache.stats().bytes).toBe(0);
  });
});
