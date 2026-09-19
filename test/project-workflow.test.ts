import { expect, test } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, output, ScriptedProvider } from './helpers.js';
import {
  projectHarness,
  stagePlan,
  draftProject,
  mutation,
  waitProject,
} from './project-helpers.js';

test('чтение → принятие плана → этап → обязательные проверки → приёмка человеком', async () => {
  const provider = new ScriptedProvider((request) => {
    if (
      request.messages.some((item) =>
        item.content.includes('Это планирование до разрешения человека.'),
      )
    )
      return output(JSON.stringify(stagePlan()));
    return output('Реализация готова.');
  });
  const app = await projectHarness(provider);
  let project = await app.projects.create({
    title: 'Проект',
    goal: 'Улучшить код',
    workspace: app.workspace,
    requestKey: 'create',
  });
  await app.projects.plan(mutation(project));
  project = await waitProject(app, project.projectId, 'ready');
  expect(app.checkCount()).toBe(0);
  expect(app.accepted).toEqual([]);
  expect(provider.requests[0]!.tools.map((tool) => tool.name)).not.toContain('process.exec');
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  project = await waitProject(app, project.projectId, 'review');
  expect(app.checkCount()).toBe(3);
  expect(project.reports.map((report) => report.phase)).toEqual(['baseline', 'stage', 'final']);
  expect(project.reports.every((report) => report.checks[0]!.exitCode === 0)).toBe(true);
  expect(app.accepted).toEqual([]);
  project = await app.projects.accept({
    ...mutation(project),
    expectedResultRevision: project.resultRevision!,
  });
  expect(project.status).toBe('completed');
  expect(app.accepted).toEqual([project.projectId]);
});

test('планирование не исполняет скрытый запрос на запись', async () => {
  const provider = new ScriptedProvider((request) =>
    request.messages.some((item) => item.role === 'tool')
      ? output(JSON.stringify(stagePlan()))
      : output('', [call('write', 'fs.write', { path: 'forbidden.txt', content: 'нельзя' })]),
  );
  const app = await projectHarness(provider);
  let project = await app.projects.create({
    title: 'План',
    goal: 'Изучить',
    workspace: app.workspace,
    requestKey: 'readonly',
  });
  await app.projects.plan(mutation(project));
  project = await waitProject(app, project.projectId, 'ready');
  await expect(readFile(join(app.workspace, 'forbidden.txt'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(project.planVersion).toBe(1);
});

test('два окна принимают план один раз; повтор запроса возвращает текущий проект', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  const request = { ...mutation(project), expectedPlanVersion: project.planVersion! };
  const results = await Promise.allSettled([
    app.projects.acceptPlan(request),
    app.projects.acceptPlan({ ...request, requestKey: 'other-window' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason.code,
  ).toBe('PROJECT_CONFLICT');
  const done = await waitProject(app, project.projectId, 'review');
  const again = await app.projects.acceptPlan(request);
  expect(again.status).toBe('review');
  expect(app.checkCount()).toBe(3);
  expect(done.stages).toHaveLength(1);
});

test('провал проверки даёт ровно две автоматические коррекции и паузу', async () => {
  let stageAnswers = 0;
  const provider = new ScriptedProvider(() => {
    stageAnswers++;
    return output('Готово');
  });
  const app = await projectHarness(provider);
  let count = 0;
  app.registry.get('process.exec').execute = async () => ({
    exitCode: count++ === 0 ? 0 : 1,
    stdout: 'Не пройдено',
    stderr: '',
  });
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  expect(paused.reasonCode).toBe('CORRECTIONS_EXHAUSTED');
  expect(paused.stages[0]!.attempt).toBe(2);
  expect(stageAnswers).toBe(3);
  expect(app.accepted).toEqual([]);
  expect(paused.reports.filter((report) => report.status === 'failed')).toHaveLength(3);
});

test('исходный провал останавливает проект до изменения кода', async () => {
  let stageAnswers = 0;
  const app = await projectHarness(
    new ScriptedProvider(() => {
      stageAnswers++;
      return output('Готово');
    }),
  );
  app.registry.get('process.exec').execute = async () => ({
    exitCode: 1,
    stdout: 'Исходный дефект',
    stderr: '',
  });
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  let paused = await waitProject(app, project.projectId, 'paused');
  expect(paused.reasonCode).toBe('BASELINE_FAILED');
  expect(stageAnswers).toBe(0);
  paused = await app.projects.editPlan({
    ...mutation(paused),
    plan: { ...stagePlan(), fixBaselineFailures: true },
  });
  expect(paused.status).toBe('ready');
  expect(paused.planVersion).toBe(2);
  expect(stageAnswers).toBe(0);
});

test('ручной этап ждёт человека, а прежняя проверка не принимает изменённые файлы', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages[0]!.verification = {
    kind: 'manual',
    instructions: 'Откройте файл и проверьте результат.',
  };
  const project = await draftProject(app, plan);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  let paused = await waitProject(app, project.projectId, 'paused');
  expect(paused.reasonCode).toBe('MANUAL_CHECK');
  expect(app.checkCount()).toBe(0);
  await writeFile(join(app.workspace, 'external.txt'), 'Внешнее изменение');
  await expect(
    app.projects.manualCheck({
      ...mutation(paused),
      stageId: 'implement',
      expectedResultRevision: paused.resultRevision!,
      outcome: 'passed',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  paused = await app.projects.recheck(mutation(paused));
  await app.projects.manualCheck({
    ...mutation(paused),
    stageId: 'implement',
    expectedResultRevision: paused.resultRevision!,
    outcome: 'passed',
  });
  const review = await waitProject(app, project.projectId, 'review');
  expect(review.changes).toEqual([{ path: 'external.txt', kind: 'added' }]);
});

test('изменение файлов после итоговых проверок требует нового прогона', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  let review = await waitProject(app, project.projectId, 'review');
  await writeFile(join(app.workspace, 'late.txt'), 'Изменено после проверок');
  await expect(
    app.projects.accept({ ...mutation(review), expectedResultRevision: review.resultRevision! }),
  ).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  await app.projects.recheck(mutation(review));
  review = await waitProject(app, project.projectId, 'review');
  expect(app.checkCount()).toBe(4);
  expect(
    (
      await app.projects.accept({
        ...mutation(review),
        expectedResultRevision: review.resultRevision!,
      })
    ).status,
  ).toBe('completed');
});
