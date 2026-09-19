import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { loadConfig } from '../configuration/loader.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import { FileSessionStore } from '../sessions/store.js';
import { DraftStore } from '../sessions/drafts.js';
import { FileLearningStore } from '../learning/store.js';
import { LearningService } from '../learning/service.js';
import { PolicyService, FileApprovalService } from '../policy/service.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolScheduler } from '../tools/scheduler.js';
import { registerLocalTools } from '../tools/local.js';
import { McpClientService } from '../mcp-client/service.js';
import { ProviderRouter } from '../providers/router.js';
import type { ModelProvider } from '../providers/types.js';
import { ContextService } from '../context/service.js';
import { InvocationExecutor } from '../runtime/executor.js';
import { HarnessRuntime } from '../runtime/engine.js';
import { SessionPurge, recoverPurges } from './session-purge.js';
import { DataReset, recoverDataResets } from './data-reset.js';
import { FileDiagnosticLog } from '../diagnostics/file-log.js';
import { ProjectPurge, recoverProjectPurges } from './project-purge.js';
import { createProjects } from './projects.js';
import type { ProjectService } from '../projects/service.js';
import { ProjectPlanService } from '../projects/plan-service.js';
import { ProjectEvidenceService } from '../projects/evidence.js';
import { ProjectExportService } from './project-export.js';

const CONFIG = Symbol('CONFIG'),
  MODEL = Symbol('MODEL');
class HarnessModule {}
Module({})(HarnessModule);
export interface Application {
  nest: INestApplicationContext;
  config: ConfigSnapshot;
  configFile: string;
  directory: string;
  runtime: HarnessRuntime;
  sessions: FileSessionStore;
  drafts: DraftStore;
  learning: LearningService;
  approvals: FileApprovalService;
  registry: ToolRegistry;
  scheduler: ToolScheduler;
  purge: SessionPurge;
  reset: DataReset;
  diagnostics: FileDiagnosticLog;
  projects: ProjectService;
  projectPlans: ProjectPlanService;
  projectEvidence: ProjectEvidenceService;
  projectExports: ProjectExportService;
  close(): Promise<void>;
}
/** Собирает модули через Nest; тесты могут заменить только модельный транспорт. */
export async function createApplication(
  configFile: string,
  directory: string,
  provider?: ModelProvider,
): Promise<Application> {
  const diagnostics = new FileDiagnosticLog(directory);
  await diagnostics.initialize();
  const config = await loadConfig(configFile);
  let projects: ProjectService | undefined;
  let startupFailure: unknown;
  try {
    await recoverPurges(directory);
    await recoverDataResets(directory);
    await recoverProjectPurges(directory);
  } catch (error) {
    startupFailure = error;
  }
  const nest = await NestFactory.createApplicationContext(
    {
      module: HarnessModule,
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: MODEL,
          useValue: provider ?? new ProviderRouter(config.value.limits.modelConcurrency),
        },
        {
          provide: FileSessionStore,
          useFactory: async () => {
            const store = new FileSessionStore(directory);
            await store.initialize({ recover: startupFailure === undefined });
            if (startupFailure !== undefined) store.requireRecovery(startupFailure);
            return store;
          },
        },
        {
          provide: FileLearningStore,
          useFactory: async () => {
            const store = new FileLearningStore(directory);
            await store.initialize();
            return store;
          },
        },
        { provide: PolicyService, useFactory: () => new PolicyService() },
        { provide: McpClientService, useFactory: () => new McpClientService() },
        { provide: ToolScheduler, useFactory: () => new ToolScheduler(config.value.limits.reads) },
        {
          provide: ToolRegistry,
          inject: [FileSessionStore, McpClientService],
          useFactory: async (store: FileSessionStore, mcp: McpClientService) => {
            const registry = new ToolRegistry();
            registerLocalTools(registry, store);
            await mcp.connect(config.value, registry);
            return registry;
          },
        },
        {
          provide: FileApprovalService,
          inject: [FileSessionStore, PolicyService],
          useFactory: (store: FileSessionStore, policy: PolicyService) =>
            new FileApprovalService(store, policy),
        },
        {
          provide: ContextService,
          inject: [FileLearningStore],
          useFactory: (store: FileLearningStore) => new ContextService(store),
        },
        {
          provide: InvocationExecutor,
          inject: [
            FileSessionStore,
            ToolRegistry,
            ToolScheduler,
            PolicyService,
            FileApprovalService,
          ],
          useFactory: (
            store: FileSessionStore,
            tools: ToolRegistry,
            scheduler: ToolScheduler,
            policy: PolicyService,
            approvals: FileApprovalService,
          ) => new InvocationExecutor(store, tools, scheduler, policy, approvals),
        },
        {
          provide: HarnessRuntime,
          inject: [
            FileSessionStore,
            FileLearningStore,
            MODEL,
            ContextService,
            ToolRegistry,
            PolicyService,
            InvocationExecutor,
          ],
          useFactory: (
            store: FileSessionStore,
            learning: FileLearningStore,
            model: ModelProvider,
            context: ContextService,
            tools: ToolRegistry,
            policy: PolicyService,
            executor: InvocationExecutor,
          ) =>
            new HarnessRuntime({
              configFile,
              initialConfig: config,
              store,
              learning,
              provider: model,
              context,
              registry: tools,
              policy,
              executor,
            }),
        },
        {
          provide: LearningService,
          inject: [FileLearningStore, FileSessionStore, MODEL, PolicyService, HarnessRuntime],
          useFactory: (
            store: FileLearningStore,
            sessions: FileSessionStore,
            model: ModelProvider,
            policy: PolicyService,
            runtime: HarnessRuntime,
          ) =>
            new LearningService(
              store,
              sessions,
              config.value,
              runtime.usage.provider(model),
              policy,
              () => runtime.busy() || !!projects?.busy(),
            ),
        },
      ],
    },
    { logger: false, abortOnError: false },
  );
  const runtime = nest.get(HarnessRuntime),
    learning = nest.get(LearningService);
  runtime.onTerminal(async (runId) => {
    const status = runtime.store.get(runId).status;
    if (status === 'completed' || status === 'failed')
      await diagnostics.record({ type: 'task.finished', runId, status });
    if (!runtime.store.get(runId).project) await learning.enqueue(runId);
  });
  const learningFailure = nest.get(FileLearningStore).recoveryError;
  if (learningFailure) runtime.store.requireRecovery(learningFailure);
  projects = await createProjects({
    directory,
    configFile,
    runtime,
    sessions: nest.get(FileSessionStore),
    learning,
    registry: nest.get(ToolRegistry),
  });
  const projectPlans = new ProjectPlanService(projects);
  const projectEvidence = new ProjectEvidenceService({
    projects: projects.store,
    sessions: nest.get(FileSessionStore),
    workspace: projects.coordinator.options.workspace,
  });
  projects.verifyAcceptance = (project) => projectEvidence.validateAccept(project);
  const projectExports = new ProjectExportService({
    directory,
    projects: projects.store,
    evidence: projectEvidence,
    serialize: (work) => projects!.coordinator.serial.run(work),
    assertWritable: () => nest.get(FileSessionStore).assertWritable(),
    acceptedPlan: (project) =>
      project.acceptedVersion
        ? projectPlans.history.read(project, project.acceptedVersion)
        : Promise.resolve(undefined),
  });
  const projectPurge = new ProjectPurge({
    projects: projects.store,
    sessions: nest.get(FileSessionStore),
    learning,
    learningStore: nest.get(FileLearningStore),
    runtime,
    scheduler: nest.get(ToolScheduler),
    busy: () => projects!.busy(),
    serialize: (work) => projects!.coordinator.serial.run(work),
    onPurged: (projectId) => {
      projectEvidence.forget(projectId);
      projectPlans.history.forget(projectId);
    },
  });
  projects.maintenance = projectPurge;
  if (!runtime.store.recoveryError) await learning.initialize();
  await diagnostics.record({ type: 'service.started' });
  let closing: Promise<void> | undefined;
  return {
    nest,
    config,
    configFile,
    directory,
    runtime,
    learning,
    diagnostics,
    projects,
    projectPlans,
    projectEvidence,
    projectExports,
    sessions: nest.get(FileSessionStore),
    drafts: new DraftStore(nest.get(FileSessionStore)),
    approvals: nest.get(FileApprovalService),
    registry: nest.get(ToolRegistry),
    scheduler: nest.get(ToolScheduler),
    purge: new SessionPurge(
      nest.get(FileSessionStore),
      learning,
      nest.get(FileLearningStore),
      runtime,
      nest.get(ToolScheduler),
      projectPurge,
    ),
    reset: new DataReset(
      nest.get(FileSessionStore),
      learning,
      nest.get(FileLearningStore),
      runtime,
      nest.get(ToolScheduler),
      projectPurge,
    ),
    /** Останавливает задачи и обучение, затем закрывает MCP, контейнер и журнал диагностики. */
    close() {
      return (closing ??= (async () => {
        const errors: unknown[] = [];
        // Каждый ресурс закрывается даже при отказе журнала предыдущего модуля.
        for (const stop of [
          () => projects!.close(),
          () => runtime.close(),
          () => learning.close(),
          () => nest.get(McpClientService).close(),
          () => nest.close(),
          () => diagnostics.record({ type: 'service.stopped' }),
          () => diagnostics.close(),
        ]) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Ошибка закрытия Harness');
      })());
    },
  };
}
