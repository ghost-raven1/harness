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
import { SessionPurge, recoverPurges } from '../sessions/purge.js';
import { DataReset, recoverDataResets } from '../application/data-reset.js';
import { FileDiagnosticLog } from '../diagnostics/file-log.js';

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
  await recoverPurges(directory);
  await recoverDataResets(directory);
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
            await store.initialize();
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
              () => runtime.busy(),
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
    await learning.enqueue(runId);
  });
  await learning.initialize();
  await diagnostics.record({ type: 'service.started' });
  return {
    nest,
    config,
    configFile,
    directory,
    runtime,
    learning,
    diagnostics,
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
    ),
    reset: new DataReset(
      nest.get(FileSessionStore),
      learning,
      nest.get(FileLearningStore),
      runtime,
      nest.get(ToolScheduler),
    ),
    async close() {
      await runtime.close();
      await learning.close();
      await nest.get(McpClientService).close();
      await nest.close();
      await diagnostics.record({ type: 'service.stopped' });
      await diagnostics.close();
    },
  };
}
