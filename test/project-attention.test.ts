import { expect, it, vi } from 'vitest';
import { projectAttention } from '../src/projects/attention.js';
import { catalogEntry, catalogEntrySchema } from '../src/sessions/catalog.js';
import type { ProjectSummary } from '../src/projects/types.js';
import type { RunCatalogEntry } from '../src/sessions/ports.js';
import { projectHarness, draftProject, mutation, waitProject } from './project-helpers.js';

/** Минимальный каталог содержит только поля, которыми пользуется вычисление ожидания. */
function run(projectId: string, changes: Partial<RunCatalogEntry> = {}): RunCatalogEntry {
  return {
    id: 'run',
    project: { projectId, planVersion: 1, attempt: 0, kind: 'stage', stageId: 'implement' },
    pendingApprovals: [],
    unknownOutcome: false,
    status: 'running',
    ...changes,
  } as RunCatalogEntry;
}
function project(changes: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: 'project',
    title: 'Проверка',
    goal: 'Цель',
    workspace: '/tmp/example',
    profile: 'test',
    revision: 1,
    status: 'ready',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    progress: { total: 1, completed: 0, running: 0, blocked: 0 },
    currentRunId: 'run',
    ...changes,
  };
}

it('приоритет ожидания: хранение, неизвестный исход, разрешение, принятие плана', () => {
  const entry = run('project', {
    unknownOutcome: true,
    pendingApprovals: [{}] as RunCatalogEntry['pendingApprovals'],
  });
  expect(projectAttention([project()], [entry], 'Журнал повреждён')[0]?.attention?.code).toBe(
    'STORAGE_UNAVAILABLE',
  );
  expect(projectAttention([project()], [entry])[0]?.attention).toMatchObject({
    code: 'UNKNOWN_OUTCOME',
    action: 'resolve',
    runId: 'run',
  });
  entry.unknownOutcome = false;
  expect(projectAttention([project()], [entry])[0]?.attention?.action).toBe('approvals');
  entry.pendingApprovals = [];
  expect(projectAttention([project()], [entry])[0]?.attention?.action).toBe('acceptPlan');
  expect(
    projectAttention([project()], [run('other', { unknownOutcome: true })])[0]?.attention?.action,
  ).toBe('acceptPlan');
});

it('ограничение провайдера показывает время, но не заменяет его автоматическим продолжением', () => {
  const retryAt = '2026-09-19T13:00:00Z';
  const entries = projectAttention(
    [project({ status: 'paused' })],
    [run('project', { pauseReason: 'provider', providerPause: { kind: 'rate_limit', retryAt } })],
  );
  expect(entries[0]?.attention).toMatchObject({
    code: 'PROVIDER_LIMIT',
    action: 'resume',
    retryAt,
  });
  expect(
    projectAttention([project({ status: 'paused', reasonCode: 'MANUAL_CHECK' })], [])[0]?.attention
      ?.action,
  ).toBe('manualCheck');
  expect(projectAttention([project({ status: 'review' })], [])[0]?.attention?.action).toBe(
    'review',
  );
  expect(projectAttention([project({ status: 'completed' })], [])[0]?.attention).toBeUndefined();
});

it('список решений и счётчик читают только каталоги, не полные состояния и переписки', async () => {
  const app = await projectHarness();
  const ready = await draftProject(app);
  const unplanned = await app.projects.create({
    title: 'Черновик',
    goal: 'Позже',
    workspace: app.workspace,
    requestKey: 'later',
  });
  const get = vi.spyOn(app.projectStore, 'get').mockRejectedValue(new Error('История запрещена'));
  const load = vi.spyOn(app.sessions, 'load').mockRejectedValue(new Error('Переписка запрещена'));
  const inspect = vi
    .spyOn(app.projects.runs, 'inspect')
    .mockRejectedValue(new Error('Запуск запрещён'));
  const list = await app.projects.list({ attentionOnly: true });
  expect(list).toMatchObject({ attentionCount: 1, total: 1 });
  expect(list.items.map((item) => item.projectId)).toEqual([ready.projectId]);
  expect((await app.projects.list()).items.map((item) => item.projectId)).toContain(
    unplanned.projectId,
  );
  expect(get).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  get.mockRestore();
  load.mockRestore();
  inspect.mockRestore();
});

it('каталог запуска сохраняет паузу провайдера без изменения формата старых записей', async () => {
  const app = await projectHarness();
  const ready = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  const review = await waitProject(app, ready.projectId, 'review');
  const saved = await app.sessions.load(review.currentRunId!);
  saved.status = 'paused';
  saved.pauseReason = 'provider';
  saved.providerPause = { kind: 'quota', retryAt: '2026-09-20T00:00:00Z' };
  const row = catalogEntry(saved, 1);
  expect(catalogEntrySchema.parse(row).providerPause).toEqual(saved.providerPause);
  const { pauseReason: _reason, providerPause: _pause, ...legacy } = row;
  expect(catalogEntrySchema.parse(legacy).providerPause).toBeUndefined();
});
