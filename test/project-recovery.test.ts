import { expect, test, vi } from 'vitest';
import { ProjectCoordinator } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { ProjectService } from '../src/projects/service.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { WorkspaceLeases } from '../src/projects/workspace-leases.js';
import type { ProjectRecord } from '../src/projects/types.js';
import { ProviderError } from '../src/providers/errors.js';
import { cleanup, eventually, output, ScriptedProvider, call } from './helpers.js';
import {
  projectHarness,
  draftProject,
  mutation,
  waitProject,
  stagePlan,
} from './project-helpers.js';

type Fixture = Awaited<ReturnType<typeof projectHarness>>;

/** Имитирует отказ владельца на выбранной границе: после неё журнал больше не принимает записи. */
function crashAt(
  app: Fixture,
  target: string,
  matches: (run: ProjectRecord) => boolean,
  before = false,
) {
  const save = app.projectStore.save.bind(app.projectStore);
  let crashed = false;
  const spy = vi
    .spyOn(app.projectStore, 'save')
    .mockImplementation(async (record, expected, type, message) => {
      if (crashed) throw new Error('Fixture owner is down');
      const hit = type === target && matches(record);
      if (hit && before) {
        crashed = true;
        throw new Error('Fixture crash before commit');
      }
      const result = await save(record, expected, type, message);
      if (hit) {
        crashed = true;
        throw new Error('Fixture crash after commit');
      }
      return result;
    });
  return { crashed: () => crashed, restore: () => spy.mockRestore() };
}

/** Пересоздаёт проектный владелец из настоящего JSONL; завершённые run остаются источником истины. */
async function restart(app: Fixture) {
  await app.projects.close();
  for (const run of app.sessions.catalog(true)) await app.runtime.wait(run.id);
  const store = new ProjectStore(app.sessions.directory);
  await store.initialize();
  expect(store.recoveryError).toBeUndefined();
  const leases = new WorkspaceLeases(() =>
    app.sessions.catalog(true).map((run) => ({
      workspace: run.workspace,
      projectId: run.project?.projectId,
      active: app.runtime.busy(run.id),
      unknown: run.unknownOutcome,
    })),
  );
  app.runtime.setWorkspaceAccess(leases);
  const coordinator = new ProjectCoordinator({
    store,
    leases,
    runs: app.runtime.projectRuns(),
    workspace: new ProjectWorkspace(app.sessions.directory),
    tools: app.registry,
    onAccepted: async () => undefined,
  });
  await coordinator.initialize();
  const projects = new ProjectService(
    coordinator,
    async () => app.snapshot,
    () => app.learning.read().activeVersion,
  );
  cleanup(() => projects.close());
  return { ...app, projects, coordinator, leases, projectStore: store };
}

test.each([
  {
    event: 'project.execution_prepared',
    before: false,
    created: false,
    label: 'до создания runtime',
  },
  {
    event: 'project.execution_started',
    before: true,
    created: true,
    label: 'после create до привязки runId',
  },
  {
    event: 'project.stage_result',
    before: true,
    created: true,
    label: 'после выполнения до settle',
  },
  {
    event: 'project.stage_result',
    before: false,
    created: true,
    label: 'после результата до проверок',
  },
])('восстановление $label не повторяет выполненный этап', async ({ event, before, created }) => {
  const provider = new ScriptedProvider((_, index) =>
    index
      ? output('Этап выполнен ровно один раз')
      : output('', [
          call('write-once', 'fs.write', { path: 'result.txt', content: 'Сохранённый результат' }),
        ]),
  );
  const app = await projectHarness(provider);
  const write = app.registry.get('fs.write').execute;
  let writes = 0;
  app.registry.get('fs.write').execute = async (input, context) => {
    writes++;
    return write(input, context);
  };
  const project = await draftProject(app);
  const crash = crashAt(
    app,
    event,
    (record) => event === 'project.stage_result' || record.intent?.kind === 'stage',
    before,
  );
  await app.projects
    .acceptPlan({ ...mutation(project), expectedPlanVersion: project.planVersion! })
    .catch(() => undefined);
  await eventually(crash.crashed);
  await eventually(() => !!app.projectStore.recoveryError);
  await app.projects.close();
  for (const run of app.sessions.catalog(true)) await app.runtime.wait(run.id);
  crash.restore();
  const restored = await restart(app);
  let paused = await restored.projects.detail({ projectId: project.projectId });
  expect(paused.status).toBe('paused');
  const beforeRequests = provider.requests.length;
  expect(beforeRequests).toBe(created ? 2 : 0);
  const state = await restored.projectStore.get(project.projectId);
  if (created && state.intent?.kind === 'stage') {
    expect(state.intent.runId).toBeTruthy();
    expect(state.stages.implement!.runId).toBe(state.intent.runId);
    expect(state.stages.implement!.sessionId).toBe(state.intent.sessionId);
  }
  if (created) {
    await expect(
      restored.projects.resume({ ...mutation(paused), acceptChanges: true }),
    ).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    paused = await restored.projects.detail({ projectId: project.projectId });
    expect(paused.externalChanges).toEqual([{ path: 'result.txt', kind: 'added' }]);
  }
  await restored.projects.resume({ ...mutation(paused), acceptChanges: true });
  await waitProject(restored, project.projectId, 'review');
  expect(provider.requests).toHaveLength(2);
  expect(writes).toBe(1);
  expect(app.checkCount()).toBe(3);
});

test('подтверждённый baseline report не запускает ту же проверку заново после аварии', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  const crash = crashAt(
    app,
    'project.stage_verified',
    (record) => record.reports.at(-1)?.phase === 'baseline',
  );
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(crash.crashed);
  await eventually(() => !!app.projectStore.recoveryError);
  await app.projects.close();
  crash.restore();
  const restored = await restart(app);
  const paused = await restored.projects.detail({ projectId: project.projectId });
  expect(app.checkCount()).toBe(1);
  await restored.projects.resume(mutation(paused));
  await waitProject(restored, project.projectId, 'review');
  expect(app.checkCount()).toBe(3);
});

test('раннее resume после rate limit оставляет проект на паузе и освобождает lease', async () => {
  const provider = new ScriptedProvider(() => {
    throw new ProviderError('retry later', true, false, {
      kind: 'rate_limit',
      retryAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  const app = await projectHarness(provider);
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  await expect(app.projects.resume(mutation(paused))).rejects.toThrow();
  const after = await app.projects.detail({ projectId: project.projectId });
  expect(after.status).toBe('paused');
  expect(app.leases.busy()).toBe(false);
  expect(provider.requests).toHaveLength(1);
});

test('предел шагов продолжает тот же этап и сохраняет выполненные вызовы', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index ? output('Готово') : output('', [call('read-once', 'fs.list', { path: '.' })]),
  );
  const app = await projectHarness(provider);
  app.snapshot.value.limits.turns = 1;
  const { hash } = await import('../src/shared/primitives.js');
  app.snapshot.hash = hash(app.snapshot.value);
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  expect(paused.reasonCode).toBe('iterations');
  const first = (await app.projectStore.get(project.projectId)).intent!.runId!;
  const events = await app.sessions.history(first, 0);
  expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
  await app.projects.resume(mutation(paused));
  await waitProject(app, project.projectId, 'review');
  expect((await app.projectStore.get(project.projectId)).stages.implement!.runId).toBe(first);
  expect(
    (await app.sessions.history(first, 0)).filter((event) => event.type === 'tool.started'),
  ).toHaveLength(1);
});

test('обычная задача блокирует принятие проекта до освобождения папки', async () => {
  const provider = new ScriptedProvider(async (request, index) => {
    if (index) return output('Готово');
    await new Promise<void>((_, reject) =>
      request.signal!.addEventListener('abort', () => reject(new Error('cancelled')), {
        once: true,
      }),
    );
    return output('Невозможно');
  });
  const app = await projectHarness(provider);
  const ordinary = await app.runtime.start({
    message: 'Обычная задача',
    workspace: app.workspace,
    requestKey: 'ordinary',
  });
  await eventually(() => provider.requests.length === 1);
  const project = await draftProject(app);
  const request = { ...mutation(project), expectedPlanVersion: project.planVersion! };
  await expect(app.projects.acceptPlan(request)).rejects.toMatchObject({
    code: 'PROJECT_CONFLICT',
  });
  expect((await app.projects.detail({ projectId: project.projectId })).status).toBe('ready');
  await app.runtime.cancel(ordinary.runId);
  await app.projects.acceptPlan(request);
  await waitProject(app, project.projectId, 'review');
});

test('пауза проверок дожидается начатой команды, а resume пропускает её подтверждённый результат', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  const verification = plan.stages[0]!.verification;
  if (verification.kind !== 'commands') throw new Error('Fixture requires commands');
  verification.checks.push({
    id: 'second',
    title: 'Вторая проверка',
    command: process.execPath,
    args: ['--version'],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  app.registry.get('process.exec').execute = async (_, context) => {
    if (++calls === 1) {
      await gate;
      expect(context.signal.aborted).toBe(false);
    }
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const project = await draftProject(app, plan);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(() => calls === 1);
  const running = await app.projects.detail({ projectId: project.projectId });
  const pause = app.projects.pause(mutation(running));
  await eventually(() =>
    app.sessions.catalog().some((run) => app.sessions.get(run.id).pauseRequested),
  );
  release();
  await pause;
  const paused = await waitProject(app, project.projectId, 'paused');
  expect(calls).toBe(1);
  await app.projects.resume(mutation(paused));
  await waitProject(app, project.projectId, 'review');
  expect(calls).toBe(6);
});

test('потеря ответа доставки уточнения не создаёт дубликат сообщения после pause/resume', async () => {
  const provider = new ScriptedProvider(async (request, index) => {
    if (index) {
      expect(
        request.messages.some(
          (item) => item.role === 'user' && item.content === 'Уточнение пользователя',
        ),
      ).toBe(true);
      return output('Уточнение выполнено');
    }
    await new Promise<void>((_, reject) =>
      request.signal!.addEventListener('abort', () => reject(new Error('paused')), { once: true }),
    );
    return output('Невозможно');
  });
  const app = await projectHarness(provider);
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(() => provider.requests.length === 1);
  const current = await app.projects.detail({ projectId: project.projectId });
  const runId = (await app.projectStore.get(project.projectId)).intent!.runId!;
  const send = app.coordinator.options.runs.sendMessage.bind(app.coordinator.options.runs);
  const spy = vi
    .spyOn(app.coordinator.options.runs, 'sendMessage')
    .mockImplementationOnce(async (input) => {
      await send(input);
      throw new Error('Fixture lost message response');
    });
  await expect(
    app.projects.message({
      ...mutation(current),
      stageId: 'implement',
      message: 'Уточнение пользователя',
    }),
  ).rejects.toThrow('lost message response');
  spy.mockRestore();
  expect((await app.sessions.load(runId)).userMessages).toHaveLength(1);
  const live = await app.projects.detail({ projectId: project.projectId });
  await app.projects.pause(mutation(live));
  const paused = await waitProject(app, project.projectId, 'paused');
  await app.projects.resume(mutation(paused));
  await waitProject(app, project.projectId, 'review');
  expect((await app.sessions.load(runId)).userMessages).toHaveLength(1);
  expect((await app.projectStore.get(project.projectId)).messages?.every((item) => item.sent)).toBe(
    true,
  );
});

test('повторная итоговая проверка не пропускает незавершённый этап после rate limit', async () => {
  const provider = new ScriptedProvider(() => {
    throw new ProviderError('retry later', true, false, {
      kind: 'rate_limit',
      retryAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  const app = await projectHarness(provider);
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  await expect(app.projects.recheck(mutation(paused))).rejects.toMatchObject({
    code: 'PROJECT_CONFLICT',
  });
  expect((await app.projects.detail({ projectId: project.projectId })).status).toBe('paused');
  expect(app.checkCount()).toBe(1);
});

test('ручное подтверждение будущего этапа не обходит зависимости текущего', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages[0]!.verification = { kind: 'manual', instructions: 'Проверьте первый этап.' };
  plan.stages.push({
    ...plan.stages[0]!,
    id: 'second',
    title: 'Второй этап',
    dependsOn: ['implement'],
  });
  const project = await draftProject(app, plan);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  await expect(
    app.projects.manualCheck({
      ...mutation(paused),
      stageId: 'second',
      expectedResultRevision: paused.resultRevision!,
      outcome: 'passed',
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
  expect((await app.projectStore.get(project.projectId)).stages.second!.status).toBe('pending');
});

test('служебное имя этапа не повреждает таблицу состояний проекта', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages[0]!.id = '__proto__';
  await expect(draftProject(app, plan)).rejects.toThrow('Недопустимый идентификатор');
  expect(app.projectStore.recoveryError).toBeUndefined();
});

test('подтверждённая пауза перед отложенным settled не запускает следующие команды', async () => {
  let finishModel!: () => void;
  const modelGate = new Promise<void>((resolve) => {
    finishModel = resolve;
  });
  const provider = new ScriptedProvider(async () => {
    await modelGate;
    return output('Этап готов');
  });
  const app = await projectHarness(provider);
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(() => provider.requests.length === 1);
  const current = await app.projects.detail({ projectId: project.projectId });
  const runId = (await app.projectStore.get(project.projectId)).intent!.runId!;
  let releaseSerial!: () => void;
  const serialGate = new Promise<void>((resolve) => {
    releaseSerial = resolve;
  });
  const barrier = app.coordinator.serial.run(() => serialGate);
  const pause = app.projects.pause(mutation(current));
  finishModel();
  await app.runtime.wait(runId);
  expect(app.runtime.busy(runId)).toBe(false);
  releaseSerial();
  await barrier;
  await pause;
  await app.coordinator.serial.run(async () => undefined);
  expect((await app.projects.detail({ projectId: project.projectId })).status).toBe('paused');
  expect(app.checkCount()).toBe(1);
  expect(app.runtime.busy()).toBe(false);
  const paused = await app.projects.detail({ projectId: project.projectId });
  await app.projects.resume(mutation(paused));
  await waitProject(app, project.projectId, 'review');
  expect(provider.requests).toHaveLength(1);
  expect(app.checkCount()).toBe(3);
});
