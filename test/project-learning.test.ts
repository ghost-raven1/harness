import { expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createApplication, type Application } from '../src/application/bootstrap.js';
import type { ProjectView } from '../src/projects/types.js';
import { cleanup, temporary, configDirectory, ScriptedProvider, output, call } from './helpers.js';
import { stagePlan, mutation } from './project-helpers.js';

/** Проверяет настоящую сборку приложения: runtime, приёмку проекта и восстановление очереди. */
async function learningProject(checkExitCode = 0) {
  const root = await temporary();
  const configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  await writeFile(
    join(dirname(configFile), 'learning.json'),
    JSON.stringify({ enabled: true, cases: [] }),
  );
  await writeFile(
    join(dirname(configFile), 'policy.json'),
    JSON.stringify({ default: 'deny', rules: [{ tool: '*', decision: 'allow' }] }),
  );
  const plan = stagePlan();
  plan.stages[0]!.role = 'executor';
  const provider = new ScriptedProvider((request) => {
    if (!request.messages.some((message) => message.role === 'tool'))
      return output('', [call('verified-read', 'fs.list', { path: '.' })]);
    const planning = request.messages.some((message) =>
      message.content.includes('Это планирование до разрешения человека.'),
    );
    return output(planning ? JSON.stringify(plan) : 'Изменения готовы и проверены.');
  });
  const state = join(root, 'state');
  const app = await createApplication(configFile, state, provider);
  cleanup(() => app.close());
  app.registry.get('process.exec').execute = async () => ({
    exitCode: checkExitCode,
    stdout: 'Тест пройден',
    stderr: '',
  });
  let project = await app.projects.create({
    title: 'Приёмка обучения',
    goal: 'Проверить границы обучения',
    workspace: join(root, 'workspace'),
    requestKey: 'learning-project',
  });
  await app.projects.plan(mutation(project));
  project = await waitStatus(app, project.projectId, 'ready');
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  project = await waitStatus(app, project.projectId, 'review');
  return { app, project, configFile, state, provider };
}

/** Ждёт исполнителей и следующий проектный переход, не ограничивая всю цепочку пятью секундами. */
async function waitStatus(app: Application, projectId: string, status: ProjectView['status']) {
  const finished = new Set<string>();
  for (;;) {
    // runtime.wait включает финализаторы; барьер затем дожидается записанного перехода проекта.
    const project = await app.projects.coordinator.serial.run(() =>
      app.projects.store.get(projectId),
    );
    if (project.status === status) return app.projects.detail({ projectId });
    const runId = project.intent?.runId;
    if (
      !['running', 'planning'].includes(project.status) ||
      !runId ||
      finished.has(runId) ||
      app.projects.store.recoveryError ||
      app.sessions.recoveryError
    ) {
      throw new Error(
        'Ожидалось ' +
          status +
          ': ' +
          JSON.stringify({
            projectId,
            status: project.status,
            revision: project.revision,
            phase: project.phase,
            reasonCode: project.reasonCode,
            reason: project.reason,
            runId,
            recoveryError: app.projects.store.recoveryError ?? app.sessions.recoveryError,
            runs: app.sessions
              .catalog(true)
              .filter((run) => run.project?.projectId === projectId)
              .map((run) => ({ id: run.id, status: run.status, busy: app.runtime.busy(run.id) })),
          }),
      );
    }
    await app.runtime.wait(runId);
    finished.add(runId);
  }
}

test('ожидание приёмки сообщает причину неожиданной паузы и состояния запусков', async () => {
  await expect(learningProject(1)).rejects.toThrow(
    /Ожидалось review:.*"status":"paused".*"reasonCode":"BASELINE_FAILED".*"runs":\[.*"status":"failed","busy":false/,
  );
});

test('до приёмки проекта ни финализация, ни enqueue, ни отзыв не создают опыт', async () => {
  const { app, project } = await learningProject();
  const runs = app.sessions.catalog().filter((run) => run.project?.projectId === project.projectId);
  expect(runs).toHaveLength(5);
  for (const run of runs) {
    await app.learning.enqueue(run.id);
    await expect(
      app.learning.feedback(run.id, true, 'Преждевременное подтверждение'),
    ).rejects.toThrow();
  }
  await app.learning.initialize();
  const learning = app.learning.store.read();
  expect(learning.jobs).toEqual([]);
  expect(learning.evidence).toEqual({});
  expect(learning.activeVersion).toBe('baseline');
});

test('приёмка ставит этапы и проверки в очередь ровно один раз, включая перезапуск', async () => {
  const { app, project, configFile, state, provider } = await learningProject();
  const request = { ...mutation(project), expectedResultRevision: project.resultRevision! };
  await app.projects.accept(request);
  const jobs = app.learning.store.read().jobs;
  expect(jobs).toHaveLength(4);
  const expected = app.sessions
    .catalog()
    .filter((run) => run.project?.kind !== 'planning')
    .map((run) => run.id)
    .sort();
  expect(jobs.map((job) => job.runId).sort()).toEqual(expected);
  await app.projects.accept(request);
  expect(app.learning.store.read().jobs.map((job) => job.id)).toEqual(jobs.map((job) => job.id));
  await app.close();
  const restored = await createApplication(configFile, state, provider);
  cleanup(() => restored.close());
  expect(restored.learning.store.read().jobs.map((job) => job.id)).toEqual(
    jobs.map((job) => job.id),
  );
  expect(restored.learning.store.read().activeVersion).toBe('baseline');
});

test('даже после приёмки положительный отзыв о планировщике не обходит запрет обучения', async () => {
  const { app, project } = await learningProject();
  await app.projects.accept({
    ...mutation(project),
    expectedResultRevision: project.resultRevision!,
  });
  const planning = app.sessions.catalog().find((run) => run.project?.kind === 'planning')!;
  const before = app.learning.store.read();
  await app.learning.enqueue(planning.id);
  await expect(app.learning.feedback(planning.id, true, 'План выглядит верным')).rejects.toThrow();
  await app.learning.initialize();
  const after = app.learning.store.read();
  expect(after.jobs).toEqual(before.jobs);
  expect(after.evidence).toEqual(before.evidence);
});
