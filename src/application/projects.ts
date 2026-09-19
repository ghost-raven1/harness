import { loadConfig } from '../configuration/loader.js';
import { ProjectStore } from '../projects/store.js';
import { ProjectWorkspace } from '../projects/workspace.js';
import { WorkspaceLeases } from '../projects/workspace-leases.js';
import { ProjectCoordinator } from '../projects/coordinator.js';
import { ProjectService } from '../projects/service.js';
import type { HarnessRuntime } from '../runtime/engine.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { LearningService } from '../learning/service.js';
import type { ToolRegistry } from '../tools/registry.js';

/** Соединяет проектные решения с runtime; зависимости доменных модулей направлены к портам. */
export async function createProjects(input: {
  directory: string;
  configFile: string;
  runtime: HarnessRuntime;
  sessions: FileSessionStore;
  learning: LearningService;
  registry: ToolRegistry;
}): Promise<ProjectService> {
  const { directory, runtime, sessions, learning, registry } = input;
  const store = new ProjectStore(directory);
  await store.initialize(!sessions.recoveryError);
  if (!store.recoveryError) await verifyProjectLinks(store, sessions);
  if (store.recoveryError) sessions.requireRecovery(store.recoveryError);
  const leases = new WorkspaceLeases(() =>
    sessions.catalog(true).map((run) => ({
      workspace: run.workspace,
      projectId: run.project?.projectId,
      unknown: run.unknownOutcome,
      active: runtime.busy(run.id) || ['running', 'awaiting_approval'].includes(run.status),
    })),
  );
  runtime.setWorkspaceAccess(leases);
  learning.setProjectAcceptance((projectId) =>
    store
      .catalog(true)
      .some((project) => project.projectId === projectId && project.status === 'completed'),
  );
  const coordinator = new ProjectCoordinator({
    store,
    runs: runtime.projectRuns(),
    workspace: new ProjectWorkspace(directory),
    leases,
    tools: registry,
    async onAccepted(project) {
      for (const runId of project.runIds) {
        const run = await sessions.load(runId);
        if (run.project?.kind !== 'planning') await learning.enqueue(runId);
      }
    },
  });
  const service = new ProjectService(
    coordinator,
    () => loadConfig(input.configFile),
    () => learning.store.read().activeVersion,
  );
  service.recoveryStatus = () => sessions.recoveryError;
  if (!sessions.recoveryError) await coordinator.initialize();
  return service;
}

/** Связи проверяются по каталогу до исполнителей, без чтения переписок обычных задач. */
async function verifyProjectLinks(store: ProjectStore, sessions: FileSessionStore): Promise<void> {
  const runs = new Map(sessions.catalog(true).map((run) => [run.id, run]));
  const projects = new Set(store.catalog(true).map((project) => project.projectId));
  try {
    for (const run of runs.values()) {
      if (run.project && !projects.has(run.project.projectId))
        throw new Error('PROJECT_ORPHAN_RUN');
    }
    for (const projectId of projects) {
      const project = await store.get(projectId);
      for (const runId of project.runIds) {
        const run = runs.get(runId);
        if (!run || run.project?.projectId !== projectId || run.workspace !== project.workspace)
          throw new Error('PROJECT_INVALID_RUN_REFERENCE');
      }
      for (const stage of Object.values(project.stages)) {
        if (!stage.runId) continue;
        const run = runs.get(stage.runId);
        if (
          !run ||
          run.sessionId !== stage.sessionId ||
          run.project?.kind !== 'stage' ||
          run.project.stageId !== stage.stageId
        )
          throw new Error('PROJECT_INVALID_STAGE_REFERENCE');
      }
    }
  } catch {
    store.recoveryError =
      'Нарушены связи проекта и его задач. Доступны просмотр и проверка истории.';
  }
}
