import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { ConfigSnapshot } from '../configuration/schema.js';
import { loadConfig, isWithin } from '../configuration/loader.js';
import type { SessionStore } from '../sessions/ports.js';
import type { LearningStore } from '../learning/types.js';
import type { RunRecord } from '../sessions/types.js';
import {
  assertKnownSessionOutcomes,
  latestSessionRun,
  missingSessionCorrections,
  sessionCorrections,
} from '../sessions/continuation.js';
import type { ChatMessage } from '../providers/types.js';
import { newAgent } from '../agents/service.js';
import type { IterationSettings } from './iterations.js';
import { hash, id } from '../shared/primitives.js';
import { SessionChangedError } from '../shared/session-conflict.js';
import { ApplicationError } from '../shared/application-error.js';
import {
  projectRunLinkSchema,
  type ProjectRunStart,
  type WorkspaceAccess,
} from '../sessions/project-run.js';
import { seedProjectContext, validateDependencies } from './project-context.js';

export const runInputSchema = z
  .object({
    message: z
      .string()
      .min(1)
      .max(100000)
      .refine((value) => !!value.trim(), 'Опишите задачу своими словами.'),
    workspace: z.string(),
    profile: z.string().optional(),
    sessionId: z.string().uuid().optional(),
    expectedParentRunId: z.string().uuid().optional(),
    requestKey: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (value) => !value.expectedParentRunId || !!value.sessionId,
    'Parent run requires a session',
  );
export type RunInput = z.infer<typeof runInputSchema>;
/** Выделяет настройки общих сервисов, несовместимые с продолжением без перезапуска. */
export function serviceFingerprint(value: ConfigSnapshot['value']): string {
  return hash({
    mcp: value.tools.mcp,
    reads: value.limits.reads,
    models: value.limits.modelConcurrency,
    learningEnabled: value.learning.enabled,
  });
}

/** Создаёт снимок запуска, сохраняя идемпотентность и историю сессии. */
export class RunFactory {
  constructor(
    private readonly configFile: string,
    private readonly initialConfig: ConfigSnapshot,
    private readonly store: SessionStore,
    private readonly learning: LearningStore,
    private readonly iterations: IterationSettings,
  ) {}
  /** Перечитывает авторскую конфигурацию для нового запуска либо возвращает тестовый снимок. */
  private currentConfig(): Promise<ConfigSnapshot> {
    return this.configFile ? loadConfig(this.configFile) : Promise.resolve(this.initialConfig);
  }
  /** Возвращает актуальный предел из конфигурации без изменения снимков существующих задач. */
  async currentIterationLimit(): Promise<number> {
    return (await this.currentConfig()).value.limits.turns;
  }
  /** Создаёт запуск или возвращает прежний результат идентичного запроса. */
  async create(input: RunInput, reserve: WorkspaceAccess['reserve'] = () => () => undefined) {
    return this.prepare(input, reserve);
  }
  /** Создаёт управляемый запуск с конфигурацией и опытом, закреплёнными проектом. */
  async createPinned(input: ProjectRunStart, reserve: WorkspaceAccess['reserve']) {
    const pinned = structuredClone(input);
    projectRunLinkSchema.parse(pinned.link);
    if (hash(pinned.config.value) !== pinned.config.hash)
      throw new Error('Invalid config snapshot hash');
    if (!this.learning.read().releases[pinned.learningVersion])
      throw new Error('Unknown learning version');
    if (!pinned.config.value.roles[pinned.role]) throw new Error('Unknown project role');
    if (pinned.link.kind === 'checks') {
      if (!pinned.calls?.length || pinned.calls.length > 100)
        throw new Error('Checks require 1 to 100 calls');
      if (new Set(pinned.calls.map((call) => call.id)).size !== pinned.calls.length)
        throw new Error('Duplicate check call IDs');
      for (const call of pinned.calls) {
        if (!call.id || call.name !== 'process.exec')
          throw new Error('Checks require process.exec calls');
        z.object({ command: z.string().min(1), args: z.array(z.string()).max(100) })
          .strict()
          .parse(JSON.parse(call.arguments));
      }
    } else if (pinned.calls !== undefined)
      throw new Error('Only checks may contain deterministic calls');
    if ((pinned.dependencies?.length ?? 0) > 100) throw new Error('Too many project dependencies');
    const { message, workspace, profile, sessionId, expectedParentRunId, requestKey } = pinned;
    return this.prepare(
      { message, workspace, profile, sessionId, expectedParentRunId, requestKey },
      reserve,
      pinned,
    );
  }
  /** Подготавливает общий снимок; резервирование папки живёт до остановки исполнителя. */
  private async prepare(
    input: RunInput,
    reserve: WorkspaceAccess['reserve'],
    pinned?: ProjectRunStart,
  ): Promise<{ run: RunRecord; created: boolean; release?: () => void }> {
    const request = runInputSchema.parse(input);
    this.store.assertRequestAllowed(request.requestKey, request.sessionId);
    const requestHash = hash(pinned ?? request);
    const previous = this.store.catalog(true).find((run) => run.requestKey === request.requestKey);
    if (previous) {
      if (previous.project && !pinned)
        throw new ApplicationError('PROJECT_MANAGED', 'Этой задачей управляет проект.');
      if (previous.requestHash !== requestHash)
        throw new Error('Idempotency key reused with different arguments');
      return { run: await this.store.load(previous.id), created: false };
    }
    if (request.sessionId) {
      const session = this.store.catalog(true).filter((run) => run.sessionId === request.sessionId);
      if (!pinned && session.some((run) => !!run.project))
        throw new ApplicationError('PROJECT_MANAGED', 'Продолжайте эту беседу через проект.');
      assertKnownSessionOutcomes(session);
    }
    const config = pinned?.config ?? (await this.currentConfig());
    if (serviceFingerprint(config.value) !== serviceFingerprint(this.initialConfig.value)) {
      throw new Error(
        'Service settings changed; restart harness serve to apply MCP, concurrency or learning settings changes',
      );
    }
    const workspace = await realpath(request.workspace);
    if (!config.value.workspaces.some((root) => isWithin(root, workspace)))
      throw new Error('Workspace is not authorized in configuration');
    const profile = request.profile ?? config.value.defaultProfile;
    if (!config.value.profiles[profile]) throw new Error('Unknown model profile: ' + profile);
    const role =
      pinned?.link.kind === 'checks'
        ? config.value.defaultRole
        : (pinned?.role ?? config.value.defaultRole);
    const agent = newAgent(role, request.message);
    if (pinned) agent.authorityRoles = [...new Set([config.value.defaultRole, role])];
    const release = reserve({ workspace, projectId: pinned?.link.projectId });
    let savedId: string | undefined;
    try {
      if (pinned)
        await validateDependencies(
          this.store,
          workspace,
          pinned.link.projectId,
          pinned.dependencies ?? [],
        );
      let parentRunId: string | undefined;
      let sessionRevision: string | undefined;
      if (request.sessionId) {
        sessionRevision = this.store.sessionRevision(request.sessionId);
        const sessionRuns = this.store
          .catalog(true)
          .filter((run) => run.sessionId === request.sessionId);
        if (!pinned && sessionRuns.some((run) => !!run.project))
          throw new ApplicationError('PROJECT_MANAGED', 'Продолжайте эту беседу через проект.');
        assertKnownSessionOutcomes(sessionRuns);
        const latest = latestSessionRun(sessionRuns);
        const last = latest ? await this.store.load(latest.id) : undefined;
        if (!last) throw new Error('Unknown session');
        if (last.project && (!pinned || last.project.projectId !== pinned.link.projectId))
          throw new ApplicationError('PROJECT_MANAGED', 'Продолжайте эту беседу через проект.');
        if (pinned && (!last.project || last.project.projectId !== pinned.link.projectId))
          throw new ApplicationError('PROJECT_CONFLICT', 'Беседа не принадлежит этому проекту.');
        if (request.expectedParentRunId && last.id !== request.expectedParentRunId)
          throw new SessionChangedError(last.id);
        parentRunId = last.id;
        if (last.workspace !== workspace) throw new Error('Session workspace cannot change');
        const prior = last.agents[last.rootAgentId]!;
        agent.summary = prior.summary;
        // Закрывает оборванные обмены перед новым пользовательским ходом, не повторяя действий.
        const interrupted: ChatMessage[] = (prior.pending ?? []).map((call) => ({
          role: 'tool' as const,
          toolCallId: call.id,
          content:
            last.invocations[prior.id + ':' + call.id]?.result ??
            JSON.stringify({
              error: 'Previous run ended before this call completed; consult its status',
            }),
        }));
        agent.messages = [
          ...prior.messages,
          ...interrupted,
          ...missingSessionCorrections(await sessionCorrections(this.store, sessionRuns), prior),
          ...(last.userMessages ?? [])
            .filter((item) => !item.deliveredAt)
            .map((item): ChatMessage => ({ role: 'user', content: item.content })),
          ...agent.messages,
        ];
        agent.completedCalls = prior.messages.flatMap(
          (item) => item.toolCalls?.map((call) => call.id) ?? [],
        );
      }
      const run: RunRecord = {
        schemaVersion: 1,
        id: id(),
        sessionId: request.sessionId ?? id(),
        requestKey: request.requestKey,
        requestHash,
        ...(parentRunId ? { parentRunId } : {}),
        ...((!pinned || pinned.link.kind === 'stage') && config.value.coordination === 'auto'
          ? { coordination: { attempts: 0 } }
          : {}),
        workspace,
        profile,
        config,
        learningVersion: pinned?.learningVersion ?? this.learning.read().activeVersion,
        ...(pinned
          ? {
              project: pinned.link,
              projectChecks: pinned.calls,
              projectDependencies: pinned.dependencies ?? [],
              projectContextReady: false,
            }
          : {}),
        status: 'running',
        rootAgentId: agent.id,
        agents: { [agent.id]: agent },
        invocations: {},
        approvals: {},
        artifacts: [],
        turns: 0,
        iterationLimit: pinned
          ? config.value.limits.turns
          : await this.iterations.defaultLimit(config.value.limits.turns),
        iterationStart: 0,
        handoffs: 0,
        usage: { input: 0, output: 0 },
        createdAt: new Date().toISOString(),
      };
      const created = await this.store.create(run, sessionRevision);
      if (created.id !== run.id) {
        release();
        return { run: created, created: false };
      }
      savedId = created.id;
      if (pinned) await seedProjectContext(this.store, created.id);
      return { run: await this.store.load(created.id), created: true, release };
    } catch (error) {
      release();
      if (savedId) {
        try {
          await this.store.mutate(savedId, 'run.preparation_failed', {}, (run) => {
            run.status = 'paused';
            run.error =
              'Подготовка контекста проекта прервана. Продолжите после устранения причины.';
          });
        } catch {
          this.store.requireRecovery(error);
        }
      }
      throw error;
    }
  }
}
