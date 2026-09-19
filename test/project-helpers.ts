import { id } from '../src/shared/primitives.js';
import { ProjectStore } from '../src/projects/store.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { WorkspaceLeases } from '../src/projects/workspace-leases.js';
import { ProjectCoordinator } from '../src/projects/coordinator.js';
import { ProjectService } from '../src/projects/service.js';
import type { ProjectPlan, ProjectView } from '../src/projects/types.js';
import type { ModelProvider } from '../src/providers/types.js';
import { cleanup, eventually, harness, output, ScriptedProvider } from './helpers.js';

/** Офлайн-стенд использует настоящий runtime, JSONL, диспетчер и отпечатки папки. */
export async function projectHarness(
  provider: ModelProvider = new ScriptedProvider(() => output('Результат этапа')),
) {
  const app = await harness(provider, (config) => {
    config.policy.rules = config.policy.rules.filter((rule) => rule.tool !== 'process.exec');
  });
  const store = new ProjectStore(app.sessions.directory);
  await store.initialize();
  const leases = new WorkspaceLeases(() =>
    app.sessions.catalog(true).map((run) => ({
      workspace: run.workspace,
      projectId: run.project?.projectId,
      active: app.runtime.busy(run.id),
      unknown: run.unknownOutcome,
    })),
  );
  app.runtime.setWorkspaceAccess(leases);
  const accepted: string[] = [];
  const coordinator = new ProjectCoordinator({
    store,
    runs: app.runtime.projectRuns(),
    workspace: new ProjectWorkspace(app.sessions.directory),
    leases,
    tools: app.registry,
    onAccepted: async (project) => {
      accepted.push(project.id);
    },
  });
  await coordinator.initialize();
  const projects = new ProjectService(
    coordinator,
    async () => app.snapshot,
    () => app.learning.read().activeVersion,
  );
  cleanup(() => projects.close());
  let checks = 0;
  app.registry.get('process.exec').execute = async () => {
    checks++;
    return { exitCode: 0, signal: null, stdout: 'Проверено', stderr: '' };
  };
  return {
    ...app,
    projects,
    projectStore: store,
    coordinator,
    leases,
    accepted,
    checkCount: () => checks,
  };
}
export function stagePlan(maxCorrections = 2): ProjectPlan {
  return {
    maxCorrections,
    fixBaselineFailures: false,
    stages: [
      {
        id: 'implement',
        title: 'Изменить код',
        task: 'Выполни изменение и сохрани результат.',
        role: 'worker',
        dependsOn: [],
        expectedResult: 'Проверка пройдена',
        requiredTools: ['fs.read'],
        verification: {
          kind: 'commands',
          checks: [
            {
              id: 'tests',
              title: 'Тесты проекта',
              command: process.execPath,
              args: ['--test'],
            },
          ],
        },
      },
    ],
  };
}
export function mutation(view: ProjectView) {
  return { projectId: view.projectId, expectedRevision: view.revision, requestKey: id() };
}
export async function draftProject(
  app: Awaited<ReturnType<typeof projectHarness>>,
  plan = stagePlan(),
) {
  const project = await app.projects.create({
    title: 'Тестовый проект',
    goal: 'Проверяем результат разработки.',
    workspace: app.workspace,
    profile: 'test',
    requestKey: id(),
  });
  return app.projects.editPlan({ ...mutation(project), plan });
}
/** Опрос использует каталог без чтения истории; при ошибке добавляется состояние координатора. */
export async function waitProject(
  app: Awaited<ReturnType<typeof projectHarness>>,
  projectId: string,
  status: ProjectView['status'],
) {
  try {
    await eventually(
      () =>
        app.projects.store.catalog(true).find((project) => project.projectId === projectId)
          ?.status === status,
      15000,
    );
  } catch (error) {
    throw new Error(
      'Ожидалось ' + status + ': ' + JSON.stringify(await app.projects.detail({ projectId })),
      { cause: error },
    );
  }
  return app.projects.detail({ projectId });
}
