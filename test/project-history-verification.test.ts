import { expect, test } from 'vitest';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyHistory } from '../src/diagnostics/history-verification.js';
import { readJournal } from '../src/sessions/journal.js';
import type { JournalEvent } from '../src/sessions/types.js';
import type { ProjectJournalEvent } from '../src/projects/validation.js';
import { createApplication } from '../src/application/bootstrap.js';
import {
  output,
  ScriptedProvider,
  cleanup,
  temporary,
  configDirectory,
  eventually,
} from './helpers.js';
import {
  projectHarness,
  draftProject,
  mutation,
  waitProject,
  stagePlan,
} from './project-helpers.js';

/** Сохраняет связанный проект и его реальные запуски, затем останавливает владельца проектов. */
async function historyFixture() {
  const app = await projectHarness(new ScriptedProvider(() => output('PRIVATE_PROJECT_RESULT')));
  const project = await draftProject(app);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await waitProject(app, project.projectId, 'review');
  await app.projects.close();
  const state = await app.projectStore.get(project.projectId);
  for (const runId of state.runIds) await app.runtime.wait(runId);
  const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
  return { ...app, project, state, path };
}

/** Повреждает только последнюю полную строку; сама диагностика не получает право на ремонт. */
async function rewriteLast<T>(path: string, change: (event: T) => void) {
  const events = await readJournal<T>(path);
  change(events.at(-1)!);
  await writeFile(path, events.map((event) => JSON.stringify(event) + '\n').join(''));
}

test('doctor считает проекты и связанные запуски без изменения журналов и утечки содержимого', async () => {
  const app = await historyFixture();
  const paths = [
    app.path,
    ...app.state.runIds.map((runId) => join(app.sessions.directory, 'runs', runId + '.jsonl')),
  ];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  const report = await verifyHistory(app.sessions.directory);
  expect(report).toMatchObject({
    healthy: true,
    readOnly: false,
    counts: { projects: 1, runs: 4 },
    issues: [],
  });
  expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
  const exported = JSON.stringify(report);
  expect(exported).not.toContain(app.workspace);
  expect(exported).not.toContain(app.state.goal);
  expect(exported).not.toContain('PRIVATE_PROJECT_RESULT');
  expect(exported).not.toContain('--test');
});

test('doctor показывает оборванный хвост проекта и сохраняет исходные байты', async () => {
  const app = await historyFixture();
  await appendFile(app.path, '{"schemaVersion":1,"seq":');
  const before = await readFile(app.path);
  const report = await verifyHistory(app.sessions.directory);
  expect(report).toMatchObject({ healthy: false, readOnly: true });
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: 'project', code: 'JOURNAL_TORN_TAIL' }),
  );
  expect(await readFile(app.path)).toEqual(before);
});

test.each(['missing', 'workspace', 'project'] as const)(
  'doctor обнаруживает нарушенную связь project/run: %s',
  async (fault) => {
    const app = await historyFixture();
    const runId = app.state.stages.implement!.runId!;
    const runPath = join(app.sessions.directory, 'runs', runId + '.jsonl');
    if (fault === 'missing') await rm(runPath);
    if (fault === 'workspace')
      await rewriteLast<ProjectJournalEvent>(app.path, (event) => {
        event.state.workspace += '-other';
      });
    if (fault === 'project')
      await rewriteLast<JournalEvent>(runPath, (event) => {
        event.state.project!.projectId = 'other-project';
      });
    const report = await verifyHistory(app.sessions.directory);
    expect(report).toMatchObject({ healthy: false, readOnly: true });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: 'project', code: 'HISTORY_INVALID_LINK' }),
    );
  },
);

test.each(['session', 'kind'] as const)(
  'doctor проверяет ссылку этапа на нужный запуск: %s',
  async (fault) => {
    const app = await historyFixture();
    const check = app.sessions.catalog().find((run) => run.project?.kind === 'checks')!;
    await rewriteLast<ProjectJournalEvent>(app.path, (event) => {
      const stage = event.state.stages.implement!;
      if (fault === 'session') stage.sessionId = check.sessionId;
      else {
        stage.runId = check.id;
        stage.sessionId = check.sessionId;
      }
    });
    const report = await verifyHistory(app.sessions.directory);
    expect(report).toMatchObject({ healthy: false, readOnly: true });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ kind: 'project', code: 'HISTORY_INVALID_LINK' }),
    );
  },
);

test('doctor обнаруживает одинаковый ключ создания у разных проектов', async () => {
  const app = await projectHarness();
  const first = await draftProject(app);
  const second = await draftProject(app);
  const previous = await app.projectStore.get(first.projectId);
  await app.projects.close();
  const path = join(app.sessions.directory, 'project-records', second.projectId + '.jsonl');
  await rewriteLast<ProjectJournalEvent>(path, (event) => {
    event.state.requestKey = previous.requestKey;
    event.state.requestHash = previous.requestHash;
  });
  const report = await verifyHistory(app.sessions.directory);
  expect(report).toMatchObject({ healthy: false, readOnly: true });
  expect(report.issues).toContainEqual(
    expect.objectContaining({ kind: 'project', code: 'HISTORY_INVALID_LINK' }),
  );
});

test.each(['version', 'sequence', 'stage'] as const)(
  'doctor классифицирует повреждение записи проекта: %s',
  async (fault) => {
    const app = await projectHarness();
    const project = await draftProject(app);
    await app.projects.close();
    const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
    await rewriteLast<ProjectJournalEvent>(path, (event) => {
      if (fault === 'version') Object.assign(event, { schemaVersion: 99 });
      if (fault === 'sequence') event.seq++;
      if (fault === 'stage') event.state.stages = {};
    });
    const before = await readFile(path);
    const report = await verifyHistory(app.sessions.directory);
    expect(report).toMatchObject({ healthy: false, readOnly: true });
    const code = {
      version: 'STORAGE_VERSION_UNSUPPORTED',
      sequence: 'JOURNAL_INVALID_SEQUENCE',
      stage: 'HISTORY_INVALID_LINK',
    }[fault];
    expect(report.issues).toContainEqual(expect.objectContaining({ kind: 'project', code }));
    expect(await readFile(path)).toEqual(before);
  },
);

test('старт приложения с отсутствующим запуском проекта включает просмотр до обращения к модели', async () => {
  const root = await temporary();
  const configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const directory = join(root, 'state');
  const provider = new ScriptedProvider(() => output('Результат этапа'));
  const app = await createApplication(configFile, directory, provider);
  cleanup(() => app.close());
  let project = await app.projects.create({
    title: 'Проверка восстановления',
    goal: 'Сохранить результат этапа',
    workspace: join(root, 'workspace'),
    requestKey: 'startup-links',
  });
  const plan = stagePlan();
  plan.stages[0]!.role = 'executor';
  plan.stages[0]!.verification = { kind: 'manual', instructions: 'Проверить результат.' };
  project = await app.projects.editPlan({ ...mutation(project), plan });
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(
    async () => (await app.projects.detail({ projectId: project.projectId })).status === 'paused',
  );
  const stageRunId = (await app.projects.store.get(project.projectId)).stages.implement!.runId!;
  await app.close();
  const requests = provider.requests.length;
  await rm(join(directory, 'runs', stageRunId + '.jsonl'));
  const restored = await createApplication(configFile, directory, provider);
  cleanup(() => restored.close());
  expect(restored.projects.store.recoveryError).toContain('связи проекта');
  expect(restored.sessions.recoveryError).toBeTruthy();
  await expect(
    restored.runtime.start({
      message: 'Не запускать',
      workspace: join(root, 'workspace'),
      requestKey: 'blocked',
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(provider.requests).toHaveLength(requests);
  expect(restored.runtime.busy()).toBe(false);
});
