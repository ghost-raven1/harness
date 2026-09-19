import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as stateFiles from '../src/sessions/files.js';
import { ProjectEvidenceService } from '../src/projects/evidence.js';
import { ProjectExportService } from '../src/application/project-export.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import type { ProjectPlan } from '../src/projects/types.js';
import { id } from '../src/shared/primitives.js';
import { eventually } from './helpers.js';
import {
  draftProject,
  mutation,
  projectHarness,
  stagePlan,
  waitProject,
} from './project-helpers.js';

vi.mock('../src/sessions/files.js', async () => {
  const actual = await vi.importActual<typeof import('../src/sessions/files.js')>(
    '../src/sessions/files.js',
  );
  return { ...actual, atomicJson: vi.fn(actual.atomicJson) };
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import('../src/sessions/files.js')>(
    '../src/sessions/files.js',
  );
  vi.mocked(stateFiles.atomicJson).mockImplementation(actual.atomicJson);
});

/** Независимый аудит использует настоящий координатор и сохранённые вызовы проверок. */
async function reviewed(plan: ProjectPlan, stdout = 'Подтверждено') {
  const app = await projectHarness();
  app.registry.get('process.exec').execute = async () => ({
    exitCode: 0,
    signal: null,
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const draft = await draftProject(app, plan);
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

it('одинаковые ID проверок разных этапов не теряют вторую команду в итоговом отчёте', async () => {
  const plan = stagePlan();
  const second = structuredClone(plan.stages[0]!);
  second.id = 'second-stage';
  second.dependsOn = ['implement'];
  if (second.verification.kind === 'commands') second.verification.checks[0]!.args = ['--version'];
  plan.stages.push(second);
  const app = await reviewed(plan);
  const review = await app.evidence.review({ projectId: app.view.projectId });
  const final = review.reports.find((report) => report.phase === 'final')!;
  expect(final.checks.map((check) => check.args)).toEqual([['--test'], ['--version']]);
  expect(new Set(final.checks.map((check) => check.id)).size).toBe(2);
  expect(final.checks.map((check) => check.sourceId)).toEqual(['tests', 'tests']);
  expect(review.canAccept).toBe(true);
  expect(final.checks.every((check) => check.evidence === 'available')).toBe(true);
});

it('Markdown экспорт выдерживает допустимый поток с большим числом отдельных обратных кавычек', async () => {
  const stdout = '`a'.repeat(150000) + '\nКонец полного вывода';
  const app = await reviewed(stagePlan(), stdout);
  const input = {
    projectId: app.view.projectId,
    expectedRevision: app.view.revision,
    includeLogs: true,
  };
  const preview = await app.exports.preview(input);
  const exported = await app.exports.export({
    ...input,
    previewToken: preview.previewToken,
    requestKey: id(),
  });
  expect(await readFile(exported.path, 'utf8')).toContain(stdout);
});

it('успешные итоговые команды не скрывают пропавшее доказательство обязательного этапа', async () => {
  const app = await reviewed(stagePlan(), 'Журнал '.repeat(10000));
  const project = await app.projectStore.get(app.view.projectId);
  const stageReport = project.reports.find((report) => report.phase === 'stage')!;
  expect((await app.evidence.review({ projectId: project.id })).canAccept).toBe(true);
  await rm(
    join(
      app.sessions.directory,
      'artifacts',
      stageReport.runId!,
      stageReport.checks[0]!.artifactId! + '.txt',
    ),
  );
  const review = await app.evidence.review({ projectId: project.id });
  expect(review.reports.find((report) => report.phase === 'final')!.checks[0]!.evidence).toBe(
    'available',
  );
  expect(review.stages[0]!.confirmed).toBe(false);
  expect(review.canAccept).toBe(false);
  expect(review.blockers).toContain('Доказательства завершённого этапа недоступны.');
  app.projects.verifyAcceptance = (record) => app.evidence.validateAccept(record);
  await expect(
    app.projects.accept({
      ...mutation(app.view),
      expectedResultRevision: app.view.resultRevision!,
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
});

it('неопределённый fsync квитанции не уничтожает единственный файл для повторной публикации', async () => {
  const app = await reviewed(stagePlan());
  const input = { projectId: app.view.projectId, expectedRevision: app.view.revision };
  const preview = await app.exports.preview(input);
  const request = { ...input, previewToken: preview.previewToken, requestKey: id() };
  const actual = await vi.importActual<typeof import('../src/sessions/files.js')>(
    '../src/sessions/files.js',
  );
  let failed = false;
  vi.mocked(stateFiles.atomicJson).mockImplementation(async (path, value) => {
    await actual.atomicJson(path, value);
    if (!failed && path.includes(join('exports', 'projects'))) {
      failed = true;
      throw Object.assign(new Error('Ошибка fsync после публикации квитанции'), { code: 'EIO' });
    }
  });
  await expect(app.exports.export(request)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(failed).toBe(true);
  const restored = await app.exports.export(request);
  expect(await readFile(restored.path, 'utf8')).toContain('Проверяем результат разработки.');
  expect(await app.exports.export(request)).toEqual(restored);
});

it('открытая выполняющаяся проверка остаётся доступной по прежнему адресу после завершения', async () => {
  const app = await projectHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.registry.get('process.exec').execute = async () => {
    await gate;
    return { exitCode: 0, signal: null, stdout: 'Команда завершилась', stderr: '' };
  };
  const draft = await draftProject(app);
  const evidence = new ProjectEvidenceService({
    projects: app.projectStore,
    sessions: app.sessions,
    workspace: new ProjectWorkspace(app.sessions.directory),
  });
  await app.projects.acceptPlan({ ...mutation(draft), expectedPlanVersion: draft.planVersion! });
  try {
    await eventually(async () =>
      (await evidence.reports({ projectId: draft.projectId })).items.some(
        (report) => report.checks[0]?.state === 'running',
      ),
    );
    const running = (await evidence.reports({ projectId: draft.projectId })).items[0]!;
    const input = {
      projectId: draft.projectId,
      reportId: running.id,
      checkId: running.checks[0]!.id,
      stream: 'stdout' as const,
    };
    expect((await evidence.checkOutput(input)).state).toBe('running');
    release();
    await waitProject(app, draft.projectId, 'review');
    expect(await evidence.checkOutput(input)).toMatchObject({
      state: 'completed',
      exitCode: 0,
      text: 'Команда завершилась',
    });
  } finally {
    release();
  }
});
