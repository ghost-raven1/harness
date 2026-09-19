import { expect, test } from 'vitest';
import { hash } from '../src/shared/primitives.js';
import { cleanup, eventually } from './helpers.js';
import { projectHarness, draftProject, mutation, waitProject } from './project-helpers.js';

test('карточка проекта показывает ожидающее разрешение без изменения сохранённой причины', async () => {
  const app = await projectHarness();
  app.snapshot.value.policy.rules.push({ tool: 'process.exec', decision: 'ask', args: {} });
  app.snapshot.hash = hash(app.snapshot.value);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup(async () => {
    release();
  });
  let started = false;
  const execute = app.registry.get('process.exec').execute;
  // Удерживаем первую проверку после разрешения, чтобы следующая не скрыла переход счётчика к нулю.
  app.registry.get('process.exec').execute = async (input, context) => {
    if (!started) {
      started = true;
      await gate;
    }
    return execute(input, context);
  };
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(() => app.approvals.pending().length === 1);
  const before = await app.projectStore.get(project.projectId);
  const waiting = await app.projects.detail({ projectId: project.projectId });
  expect(waiting.pendingApprovals).toBe(1);
  expect(waiting.reasonCode).toBe('APPROVAL_REQUIRED');
  expect(waiting.blockers).toContainEqual(expect.objectContaining({ code: 'APPROVAL_REQUIRED' }));
  expect(waiting.stages[0]!.status).toBe('pending');
  expect(before.reasonCode).toBeUndefined();
  expect(await app.projectStore.get(project.projectId)).toEqual(before);
  expect(app.checkCount()).toBe(0);

  await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
  await eventually(() => started);
  const running = await app.projects.detail({ projectId: project.projectId });
  expect(running.pendingApprovals).toBe(0);
  expect(running.reasonCode).toBe(before.reasonCode);
  expect(running.reason).toBe(before.reason);
  expect(await app.projectStore.get(project.projectId)).toEqual(before);
  release();

  for (let remaining = 0; remaining < 2; remaining++) {
    await eventually(() => app.approvals.pending().length === 1);
    await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
  }
  const review = await waitProject(app, project.projectId, 'review');
  expect(review.pendingApprovals).toBe(0);
  expect(app.checkCount()).toBe(3);
  expect((await app.projectStore.get(project.projectId)).reasonCode).not.toBe('APPROVAL_REQUIRED');
});
