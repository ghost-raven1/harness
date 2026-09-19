import { expect, it, vi } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectCoordinator } from '../src/projects/coordinator.js';
import { ProjectStore } from '../src/projects/store.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { ProjectService } from '../src/projects/service.js';
import { ProjectChangeRecorder } from '../src/projects/change-recorder.js';
import { hash } from '../src/shared/primitives.js';
import { cleanup, call, eventually, output, ScriptedProvider } from './helpers.js';
import {
  draftProject,
  mutation,
  projectHarness,
  stagePlan,
  waitProject,
} from './project-helpers.js';

it('этапы и исправления имеют собственные точки, а проверочные команды не приписываются исполнителю', async () => {
  let iterations = 0;
  let writeNext = true;
  const app = await projectHarness(
    new ScriptedProvider(() => {
      if (!writeNext) {
        writeNext = true;
        return output('Результат сохранён');
      }
      writeNext = false;
      iterations++;
      return output('', [
        call('edit-' + iterations, 'fs.write', {
          path: 'source.txt',
          content: 'попытка ' + iterations,
        }),
      ]);
    }),
  );
  await writeFile(join(app.workspace, 'source.txt'), 'до работы');
  let checks = 0;
  app.registry.get('process.exec').execute = async () => ({
    exitCode: ++checks === 2 ? 1 : 0,
    stdout: 'result',
    stderr: '',
  });
  const ready = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  const review = await waitProject(app, ready.projectId, 'review');
  const record = await app.projectStore.get(ready.projectId);
  const stages = record.changeSets!.filter((entry) => entry.kind === 'stage');
  expect(stages.map((entry) => [entry.attempt, entry.outcome])).toEqual([
    [0, 'complete'],
    [1, 'complete'],
  ]);
  expect(record.changeSets!.filter((entry) => entry.kind === 'checks')).toHaveLength(4);
  for (const entry of record.changeSets!.filter((entry) => entry.kind === 'checks')) {
    expect(
      record.reports.some((report) => report.id === entry.reportId && report.runId === entry.runId),
    ).toBe(true);
    expect(entry.before.digest).toBe(entry.after!.digest);
  }
  const first = stages[0]!;
  expect(
    await app.coordinator.options.workspace.content.readContent(
      record.id,
      first.before.contentRef!,
      'source.txt',
    ),
  ).toBe('до работы');
  expect(
    await app.coordinator.options.workspace.content.readContent(
      record.id,
      first.after!.contentRef!,
      'source.txt',
    ),
  ).toBe('попытка 1');
  const unchanged = JSON.stringify(record.changeSets);
  const disk = await readFile(
    join(app.sessions.directory, 'project-records', record.id + '.jsonl'),
    'utf8',
  );
  await app.projects.detail({ projectId: record.id });
  expect(
    await readFile(join(app.sessions.directory, 'project-records', record.id + '.jsonl'), 'utf8'),
  ).toBe(disk);
  await app.projects.accept({
    ...mutation(review),
    expectedResultRevision: review.resultRevision!,
  });
  expect(JSON.stringify((await app.projectStore.get(record.id)).changeSets)).toBe(unchanged);
});

it('новая версия плана сохраняет исходную точку проекта и все прежние интервалы', async () => {
  const app = await projectHarness();
  await writeFile(join(app.workspace, 'source.txt'), 'исходное');
  app.registry.get('process.exec').execute = async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'исходный дефект',
  });
  const ready = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  const paused = await waitProject(app, ready.projectId, 'paused');
  const before = await app.projectStore.get(ready.projectId);
  await writeFile(join(app.workspace, 'source.txt'), 'внешняя работа');
  const edited = await app.projects.editPlan({
    ...mutation(paused),
    plan: { ...stagePlan(0), fixBaselineFailures: true },
  });
  app.registry.get('process.exec').execute = async () => ({ exitCode: 0, stdout: '', stderr: '' });
  await app.projects.acceptPlan({ ...mutation(edited), expectedPlanVersion: edited.planVersion! });
  await waitProject(app, ready.projectId, 'review');
  const after = await app.projectStore.get(ready.projectId);
  expect(after.baseline).toEqual(before.baseline);
  expect(after.changeSets!.slice(0, before.changeSets!.length)).toEqual(before.changeSets);
  expect(
    after
      .changeSets!.filter((entry) => entry.kind === 'project')
      .every((entry) => entry.before.ref === before.baseline!.ref),
  ).toBe(true);
});

it('режим копий имеет CAS, однократный запрос и не меняет прежние снимки', async () => {
  const app = await projectHarness();
  const ready = await draftProject(app);
  expect(ready.capture?.enabled).toBe(true);
  const request = { ...mutation(ready), enabled: false };
  const disabled = await app.projects.changeCapture(request);
  expect(disabled.capture?.enabled).toBe(false);
  expect((await app.projects.changeCapture(request)).revision).toBe(disabled.revision);
  await expect(
    app.projects.changeCapture({ ...request, requestKey: 'other', enabled: true }),
  ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
  const started = await app.projects.acceptPlan({
    ...mutation(disabled),
    expectedPlanVersion: disabled.planVersion!,
  });
  await expect(
    app.projects.changeCapture({ ...mutation(started), enabled: true }),
  ).rejects.toMatchObject({ code: 'TASK_BUSY' });
  await waitProject(app, ready.projectId, 'review');
  const record = await app.projectStore.get(ready.projectId);
  expect(record.capture?.enabled).toBe(false);
});

it('после сохранения файлов и до записи результата recovery связывает прежнюю точку без повторной работы', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index
      ? output('Готово')
      : output('', [call('once', 'fs.write', { path: 'result.txt', content: 'работа агента' })]),
  );
  const app = await projectHarness(provider);
  const ready = await draftProject(app);
  const originalSave = app.projectStore.save.bind(app.projectStore);
  let crashed = false;
  const stop = vi.spyOn(app.projectStore, 'save').mockImplementation(async (...args) => {
    if (args[2] === 'project.stage_result') crashed = true;
    if (crashed) throw new Error('owner stopped');
    return originalSave(...args);
  });
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  await eventually(() => crashed);
  await app.projects.close();
  stop.mockRestore();
  const stored = await app.projectStore.get(ready.projectId);
  const intent = stored.intent!;
  const saved = await app.coordinator.options.workspace.content.findAfter(
    stored.id,
    intent.runId!,
    intent.changeSetId!,
  );
  expect(saved).toBeDefined();
  await writeFile(join(app.workspace, 'result.txt'), 'правка после аварии');
  const store = new ProjectStore(app.sessions.directory);
  await store.initialize();
  const coordinator = new ProjectCoordinator({
    ...app.coordinator.options,
    store,
    workspace: new ProjectWorkspace(app.sessions.directory),
  });
  cleanup(() => coordinator.close());
  const capture = vi.spyOn(coordinator.options.workspace, 'capture');
  await coordinator.initialize();
  expect(capture).not.toHaveBeenCalled();
  const restored = await store.get(stored.id);
  const interval = restored.changeSets!.find((entry) => entry.id === intent.changeSetId)!;
  expect(interval).toMatchObject({ outcome: 'complete', after: saved });
  expect(
    await coordinator.options.workspace.content.readContent(
      stored.id,
      interval.after!.contentRef!,
      'result.txt',
    ),
  ).toBe('работа агента');
  expect(provider.requests).toHaveLength(2);
});

it('отсутствующая точка после аварии остаётся пробелом, а новый снимок не выдаётся за прежний результат', async () => {
  const app = await projectHarness();
  const ready = await draftProject(app);
  const record = await app.projectStore.get(ready.projectId);
  const recorder = new ProjectChangeRecorder(app.coordinator.options.workspace);
  const intent = { kind: 'stage' as const, stageId: 'implement', attempt: 0, message: 'работа' };
  await recorder.begin(record, intent);
  record.intent = { ...intent, requestKey: 'recovery', runId: 'completed-run' };
  recorder.link(record);
  const oldId = record.intent.changeSetId;
  const snapshot = vi.spyOn(app.coordinator.options.workspace, 'capture');
  await recorder.recovered(record);
  expect(record.changeSets![0]!.outcome).toBe('gap');
  expect(record.changeSets![0]!.after).toBeUndefined();
  expect(snapshot).not.toHaveBeenCalled();
  const current = await recorder.capture(record);
  recorder.continued(record, current);
  expect(record.intent.changeSetId).not.toBe(oldId);
  expect(record.changeSets![0]!.outcome).toBe('gap');
  expect(record.changeSets![1]!).toMatchObject({ outcome: 'pending', before: current });
});

it('исторический проект без capture можно включить явно, не меняя закреплённую конфигурацию', async () => {
  const app = await projectHarness();
  const ready = await draftProject(app);
  const record = await app.projectStore.get(ready.projectId);
  delete record.capture;
  const saved = await app.coordinator.save(record, 'fixture.legacy', 'Исторический проект');
  const configHash = hash(saved.config);
  const projects = new ProjectService(
    app.coordinator,
    async () => app.snapshot,
    () => 'baseline',
  );
  const next = await projects.changeCapture({
    projectId: saved.id,
    expectedRevision: saved.revision,
    requestKey: 'enable-legacy',
    enabled: true,
  });
  expect(next.capture?.enabled).toBe(true);
  expect(hash((await app.projectStore.get(saved.id)).config)).toBe(configHash);
});

it('внешняя правка на паузе имеет отдельный неизменный интервал после подтверждения продолжения', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index ? output('Готово') : output('', [call('read-once', 'fs.list', { path: '.' })]),
  );
  const app = await projectHarness(provider);
  app.snapshot.value.limits.turns = 1;
  app.snapshot.hash = hash(app.snapshot.value);
  await writeFile(join(app.workspace, 'source.txt'), 'до паузы');
  const ready = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  let paused = await waitProject(app, ready.projectId, 'paused');
  expect(
    (await app.projectStore.get(ready.projectId)).changeSets!.some(
      (entry) => entry.kind === 'pause',
    ),
  ).toBe(true);
  await writeFile(join(app.workspace, 'source.txt'), 'изменение пользователя');
  await expect(app.projects.resume(mutation(paused))).rejects.toMatchObject({
    code: 'PROJECT_CHANGED',
  });
  paused = await app.projects.detail({ projectId: ready.projectId });
  const external = (await app.projectStore.get(ready.projectId)).changeSets!.find(
    (entry) => entry.kind === 'external',
  )!;
  expect(external.outcome).toBe('complete');
  expect(
    await app.coordinator.options.workspace.content.readContent(
      ready.projectId,
      external.before.contentRef!,
      'source.txt',
    ),
  ).toBe('до паузы');
  expect(
    await app.coordinator.options.workspace.content.readContent(
      ready.projectId,
      external.after!.contentRef!,
      'source.txt',
    ),
  ).toBe('изменение пользователя');
  await app.projects.resume({ ...mutation(paused), acceptChanges: true });
  await waitProject(app, ready.projectId, 'review');
  expect(
    (await app.projectStore.get(ready.projectId)).changeSets!.filter(
      (entry) => entry.kind === 'external',
    ),
  ).toEqual([external]);
  expect(provider.requests).toHaveLength(2);
});

it('изменяющая файлы проверка записывает свой интервал и не становится успешным доказательством', async () => {
  const app = await projectHarness();
  await writeFile(join(app.workspace, 'source.txt'), 'до команды');
  app.registry.get('process.exec').execute = async () => {
    await writeFile(join(app.workspace, 'source.txt'), 'изменено проверочной командой');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const ready = await draftProject(app);
  await app.projects.acceptPlan({ ...mutation(ready), expectedPlanVersion: ready.planVersion! });
  const paused = await waitProject(app, ready.projectId, 'paused');
  expect(paused.reasonCode).toBe('BASELINE_FAILED');
  const record = await app.projectStore.get(ready.projectId);
  const interval = record.changeSets!.find((entry) => entry.kind === 'checks')!;
  expect(interval.before.digest).not.toBe(interval.after!.digest);
  expect(record.reports[0]!.status).toBe('failed');
  expect(record.changeSets!.filter((entry) => entry.kind === 'stage')).toEqual([]);
  expect(
    await app.coordinator.options.workspace.content.readContent(
      record.id,
      interval.after!.contentRef!,
      'source.txt',
    ),
  ).toBe('изменено проверочной командой');
});
