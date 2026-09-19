import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import { readProjectPurgeRecords } from '../src/projects/purge-records.js';
import { ProjectStore } from '../src/projects/store.js';
import { id } from '../src/shared/primitives.js';
import { cleanup } from './helpers.js';
import { fixture, files, sourceText } from './purge-fixture.js';

afterEach(() => vi.restoreAllMocks());

/** Закрепляет реальные сохранённые беседы за проектом, не вызывая внешний API. */
async function projectFixture() {
  const item = await fixture();
  const created = await item.app.projects.create({
    workspace: item.workspace,
    profile: 'test',
    title: 'Удаляемый проект',
    goal: sourceText,
    requestKey: id(),
  });
  for (const runId of [item.first.runId, item.next.runId])
    await item.app.sessions.mutate(runId, 'test.project', {}, (run) => {
      run.project = {
        projectId: created.projectId,
        planVersion: 1,
        stageId: 'test',
        attempt: 0,
        kind: 'stage',
      };
    });
  const project = await item.app.projects.store.get(created.projectId);
  // Второй запуск отсутствует в runIds: каталог должен закрывать окно между созданием запуска и ACK проекта.
  project.runIds = [item.first.runId];
  const saved = await item.app.projects.store.save(
    project,
    project.revision,
    'test.link',
    'Связаны этапы',
  );
  await mkdir(join(item.directory, 'project-artifacts', project.id), { recursive: true });
  await writeFile(
    join(item.directory, 'project-artifacts', project.id, 'snapshot.jsonl'),
    sourceText,
  );
  await mkdir(join(item.directory, 'projects', 'wizard'), { recursive: true });
  await writeFile(join(item.directory, 'projects', 'wizard', 'harness.json'), 'настройки мастера');
  const goalDraft = await item.app.drafts.create(
    { workspace: item.workspace, purpose: 'project.goal' },
    sourceText,
    project.requestKey,
  );
  const planDraft = await item.app.drafts.create(
    { workspace: item.workspace, purpose: 'project.plan', projectId: project.id },
    sourceText,
  );
  const planPath = join(item.directory, 'drafts', 'new.' + planDraft.id + '.json');
  await writeFile(planPath + '.' + id() + '.tmp', '{оборванная временная копия');
  return { ...item, project: saved, goalDraft, planDraft };
}

/** Структурные параметры подтверждения совпадают с запросом второго окна CLI. */
async function confirmation(item: Awaited<ReturnType<typeof projectFixture>>) {
  const preview = await item.app.projects.purgePreview({ projectId: item.project.id });
  return {
    projectId: item.project.id,
    expectedRevision: item.project.revision,
    requestKey: id(),
    previewToken: preview.previewToken,
  };
}

it('каскад удаляет все этапы и черновики, сохраняет рабочую папку и повторяет прежнюю квитанцию', async () => {
  const item = await projectFixture();
  const input = await confirmation(item);
  const results = await Promise.all([
    item.app.projects.purge(input),
    item.app.projects.purge(input),
  ]);
  expect(results[0]).toEqual({ purged: true, projectId: item.project.id, runs: 2 });
  expect(results[1]).toEqual(results[0]);
  expect(item.app.sessions.catalog(true).map((run) => run.id)).toEqual([item.other.runId]);
  expect(item.app.projects.store.catalog(true)).toEqual([]);
  expect(item.learning.read().candidates).toEqual({});
  const remaining = Object.keys(await files(item.directory));
  expect(
    remaining.filter((path) =>
      /\/(project-records|project-index|project-artifacts|drafts)\//.test(path),
    ),
  ).toEqual([]);
  expect(await readFile(join(item.directory, 'projects', 'wizard', 'harness.json'), 'utf8')).toBe(
    'настройки мастера',
  );
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
  const marker = (await readProjectPurgeRecords(item.directory))[0]!;
  expect(marker.complete).toBe(true);
  expect(JSON.stringify(marker)).not.toContain(item.project.requestKey);
  expect(JSON.stringify(marker)).not.toContain(sourceText);
  await item.app.close();
  const reopened = await createApplication(item.configFile, item.directory, item.provider);
  cleanup(() => reopened.close());
  expect(await reopened.projects.purge(input)).toEqual(results[0]);
  await expect(
    reopened.projects.create({
      title: 'Повтор',
      goal: sourceText,
      workspace: item.workspace,
      profile: 'test',
      requestKey: item.project.requestKey,
    }),
  ).rejects.toMatchObject({ code: 'PROJECT_MANAGED' });
});

it('прямое удаление, скрытие и восстановление файлов этапа запрещены до изменения состояния', async () => {
  const item = await projectFixture();
  const before = await files(item.directory);
  const runId = item.next.runId,
    changeId = id();
  for (const [method, input] of [
    ['runtime.delete', { runId }],
    ['runtime.purgePreview', { runId }],
    ['runtime.purge', { runId, previewToken: '0'.repeat(64) }],
    ['files.previewRestore', { runId, changeId }],
    ['files.previewResolution', { runId, changeId }],
    ['files.restore', { runId, changeId, previewToken: '0'.repeat(64) }],
    [
      'files.resolveRestore',
      { runId, changeId, previewToken: '0'.repeat(64), result: 'Проверено' },
    ],
  ] as const)
    await expect(dispatch(item.app, method, input)).rejects.toMatchObject({
      code: 'PROJECT_MANAGED',
    });
  expect(await files(item.directory)).toEqual(before);
});

it.each(['artifact', 'draft', 'run'] as const)(
  'изменение %s делает подтверждение удаления устаревшим',
  async (kind) => {
    const item = await projectFixture();
    const input = await confirmation(item);
    if (kind === 'artifact')
      await writeFile(
        join(item.directory, 'project-artifacts', item.project.id, 'snapshot.jsonl'),
        'изменилось',
      );
    if (kind === 'draft')
      await item.app.drafts.update({
        id: item.goalDraft.id,
        expectedRevision: 0,
        text: 'Изменилось',
      });
    if (kind === 'run')
      await item.app.sessions.mutate(item.next.runId, 'test.result', {}, (run) => {
        run.result = 'Новый ответ';
      });
    await expect(item.app.projects.purge(input)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect((await readProjectPurgeRecords(item.directory)).length).toBe(0);
    expect(item.app.sessions.catalog(true)).toHaveLength(3);
  },
);

it('незавершённый каскад скрывает проект, запрещает запись и завершается после перезапуска', async () => {
  const item = await projectFixture();
  const input = await confirmation(item);
  vi.spyOn(item.app.sessions, 'purgeFiles').mockRejectedValueOnce(new Error('ENOSPC'));
  await expect(item.app.projects.purge(input)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
  expect(item.app.projects.store.catalog(true)).toEqual([]);
  await expect(
    item.app.projects.store.save(item.project, item.project.revision, 'test.restore', 'Повтор'),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  const reader = new ProjectStore(item.directory);
  await reader.initialize(false);
  expect(reader.catalog(true)).toEqual([]);
  expect(reader.findRequest(item.project.requestKey)).toBe(item.project.id);
  await item.app.close();
  const reopened = await createApplication(item.configFile, item.directory, item.provider);
  cleanup(() => reopened.close());
  expect(reopened.sessions.recoveryError).toBeUndefined();
  expect(reopened.projects.store.catalog(true)).toEqual([]);
  expect(reopened.sessions.catalog(true).map((run) => run.id)).toEqual([item.other.runId]);
  expect(await reopened.projects.purge(input)).toMatchObject({ purged: true, runs: 2 });
});

it('завершённый маркер имеет приоритет над возвращённой старой копией журнала', async () => {
  const item = await projectFixture();
  const path = join(item.directory, 'project-records', item.project.id + '.jsonl');
  const journal = await readFile(path);
  const input = await confirmation(item);
  await item.app.projects.purge(input);
  await item.app.close();
  await writeFile(path, journal);
  const store = new ProjectStore(item.directory);
  await store.initialize();
  expect(store.catalog(true)).toEqual([]);
  expect(() => store.assertRequestAllowed(item.project.requestKey)).toThrow('удалён');
  await expect(store.save(item.project, 0, 'test.recreate', 'Повтор')).rejects.toThrow();
});

it.each(['tasks', 'all'] as const)(
  'общий сброс %s включает проекты и восстанавливается по единому намерению',
  async (scope) => {
    const item = await projectFixture();
    const preview = await item.app.reset.preview(scope);
    expect(preview.projects).toBe(1);
    vi.spyOn(item.app.projects.store, 'recordPurge').mockRejectedValueOnce(new Error('EIO'));
    await expect(item.app.reset.reset(scope, preview.previewToken)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    const store = new ProjectStore(item.directory);
    await store.initialize(false);
    expect(store.catalog(true)).toEqual([]);
    expect(() => store.assertRequestAllowed(item.project.requestKey)).toThrow();
    await item.app.close();
    const reopened = await createApplication(item.configFile, item.directory, item.provider);
    cleanup(() => reopened.close());
    expect(reopened.sessions.recoveryError).toBeUndefined();
    expect(reopened.sessions.catalog(true)).toEqual([]);
    expect(reopened.projects.store.catalog(true)).toEqual([]);
    expect(await reopened.reset.reset(scope, preview.previewToken)).toMatchObject({
      reset: true,
      tasks: 3,
    });
    expect(
      Object.keys((reopened.learning.store as typeof item.learning).read().candidates),
    ).toEqual(scope === 'tasks' ? ['sourceLesson'] : []);
    expect(await readFile(join(item.directory, 'projects', 'wizard', 'harness.json'), 'utf8')).toBe(
      'настройки мастера',
    );
  },
);

it('проект без этапов виден в очистке и защищает закреплённый опыт от отдельного сброса знаний', async () => {
  const item = await projectFixture();
  const knowledge = await item.app.reset.preview('learning');
  expect(knowledge.available).toBe(false);
  expect(knowledge.blockers.join(' ')).toContain('проект');
  const record = await item.app.projects.store.get(item.project.id);
  record.status = 'cancelled';
  await item.app.projects.store.save(record, record.revision, 'test.cancel', 'Отменён');
  expect((await item.app.reset.preview('learning')).available).toBe(true);
  const separate = await item.app.projects.create({
    title: 'Без этапов',
    goal: 'Черновик',
    workspace: item.workspace,
    profile: 'test',
    requestKey: id(),
  });
  expect((await item.app.reset.preview('tasks')).projects).toBe(2);
  const preview = await item.app.reset.preview('all');
  await item.app.reset.reset('all', preview.previewToken);
  await expect(item.app.projects.store.get(separate.projectId)).rejects.toThrow();
});

it('полный ручной проект с паузой и продолжением можно принять, архивировать и удалить', async () => {
  const item = await fixture();
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(item.provider, 'generate').mockImplementationOnce(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(new Error('CANCELLED')), {
          once: true,
        });
        started();
      }),
  );
  let view = await item.app.projects.create({
    workspace: item.workspace,
    profile: 'test',
    title: 'Жизненный цикл',
    goal: 'Ручной проект',
    requestKey: id(),
  });
  const mutate = () => ({
    projectId: view.projectId,
    expectedRevision: view.revision,
    requestKey: id(),
  });
  view = await item.app.projects.editPlan({
    ...mutate(),
    plan: {
      maxCorrections: 1,
      fixBaselineFailures: false,
      stages: [
        {
          id: 'manual',
          title: 'Проверить',
          task: 'Изучи файлы',
          role: 'executor',
          dependsOn: [],
          expectedResult: 'Ответ готов',
          requiredTools: ['fs.read'],
          verification: { kind: 'manual', instructions: 'Проверьте ответ' },
        },
      ],
    },
  });
  view = await item.app.projects.acceptPlan({
    ...mutate(),
    expectedPlanVersion: view.planVersion!,
  });
  await requestStarted;
  view = await item.app.projects.pause(mutate());
  const runId = view.stages[0]!.runId!;
  await item.app.runtime.wait(runId);
  await item.app.projects.coordinator.serial.run(async () => undefined);
  view = await item.app.projects.detail({ projectId: view.projectId });
  expect(view.status).toBe('paused');
  view = await item.app.projects.resume(mutate());
  await item.app.runtime.wait(runId);
  await item.app.projects.coordinator.serial.run(async () => undefined);
  view = await item.app.projects.detail({ projectId: view.projectId });
  expect(view.reasonCode).toBe('MANUAL_CHECK');
  view = await item.app.projects.manualCheck({
    ...mutate(),
    stageId: 'manual',
    expectedResultRevision: view.resultRevision!,
    outcome: 'passed',
  });
  expect(view.status).toBe('review');
  view = await item.app.projects.accept({
    ...mutate(),
    expectedResultRevision: view.resultRevision!,
  });
  view = await item.app.projects.archive(mutate());
  const preview = await item.app.projects.purgePreview({ projectId: view.projectId });
  expect(preview.available).toBe(true);
  expect(
    await item.app.projects.purge({ ...mutate(), previewToken: preview.previewToken }),
  ).toMatchObject({ purged: true, runs: 1 });
  expect(item.app.projects.store.catalog(true)).toEqual([]);
});

it('неизвестный результат и другой работающий проект блокируют каскад без маркера удаления', async () => {
  const item = await projectFixture();
  const snapshot = item.app.sessions.get(item.next.runId);
  await item.app.sessions.mutate(snapshot.id, 'test.unknown', {}, (run) => {
    run.invocations.uncertain = {
      id: 'uncertain',
      agentId: run.rootAgentId,
      call: { id: 'uncertain', name: 'fs.write', arguments: '{}' },
      effect: 'write',
      status: 'unknown',
      startedAt: new Date().toISOString(),
    };
  });
  const preview = await item.app.projects.purgePreview({ projectId: item.project.id });
  expect(preview.available).toBe(false);
  await expect(
    item.app.projects.purge({
      projectId: item.project.id,
      expectedRevision: item.project.revision,
      requestKey: id(),
      previewToken: preview.previewToken,
    }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  await item.app.sessions.mutate(snapshot.id, 'test.resolved', {}, (run) => {
    delete run.invocations.uncertain;
  });
  const other = await item.app.projects.create({
    workspace: item.workspace,
    profile: 'test',
    title: 'Другой проект',
    goal: 'Проверка',
    requestKey: id(),
  });
  const record = await item.app.projects.store.get(other.projectId);
  record.status = 'running';
  await item.app.projects.store.save(record, record.revision, 'test.active', 'Активный проект');
  expect((await item.app.projects.purgePreview({ projectId: item.project.id })).available).toBe(
    false,
  );
  expect((await item.app.reset.preview('all')).available).toBe(false);
  expect(await readProjectPurgeRecords(item.directory)).toEqual([]);
});

it('удаление обычной беседы сохраняет знания, закреплённые незавершённым проектом', async () => {
  const item = await fixture();
  const project = await item.app.projects.create({
    title: 'Использует опыт',
    goal: 'Новая задача',
    workspace: item.workspace,
    profile: 'test',
    requestKey: id(),
  });
  const before = await item.app.purge.preview(item.first.runId);
  expect(before.available).toBe(false);
  expect(before.blockers.join(' ')).toContain('проект');
  await expect(item.app.purge.purge(item.first.runId, before.previewToken)).rejects.toMatchObject({
    code: 'TASK_BUSY',
  });
  expect(item.learning.read().activeVersion).toBe('learned');
  await item.app.projects.cancel({
    projectId: project.projectId,
    expectedRevision: project.revision,
    requestKey: id(),
  });
  const after = await item.app.purge.preview(item.first.runId);
  expect(after.available).toBe(true);
  expect(await item.app.purge.purge(item.first.runId, after.previewToken)).toMatchObject({
    purged: true,
    runs: 2,
  });
});

it('ссылка из проектных артефактов наружу блокирует удаление без обхода рабочей папки', async () => {
  const item = await projectFixture();
  const source = join(item.directory, 'project-artifacts');
  await rename(source, source + '-original');
  await symlink(item.workspace, source, process.platform === 'win32' ? 'junction' : 'dir');
  const preview = await item.app.projects.purgePreview({ projectId: item.project.id });
  expect(preview.available).toBe(false);
  expect(preview.blockers.join(' ')).toContain('ссылками');
  await expect(
    item.app.projects.purge({
      projectId: item.project.id,
      expectedRevision: item.project.revision,
      requestKey: id(),
      previewToken: preview.previewToken,
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect((await item.app.reset.preview('all')).available).toBe(false);
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
  expect(await readProjectPurgeRecords(item.directory)).toEqual([]);
});
