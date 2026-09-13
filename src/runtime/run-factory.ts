import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { ConfigSnapshot } from '../configuration/schema.js';
import { loadConfig, isWithin } from '../configuration/loader.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { LearningStore } from '../learning/types.js';
import type { RunRecord } from '../sessions/types.js';
import { requiresOutcomeReview } from '../sessions/invocations.js';
import type { ChatMessage } from '../providers/types.js';
import { newAgent } from '../agents/service.js';
import type { IterationSettings } from './iterations.js';
import { hash, id } from '../shared/primitives.js';
import { SessionChangedError } from '../shared/session-conflict.js';

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
    private readonly store: FileSessionStore,
    private readonly learning: LearningStore,
    private readonly iterations: IterationSettings,
  ) {}
  private currentConfig(): Promise<ConfigSnapshot> {
    return this.configFile ? loadConfig(this.configFile) : Promise.resolve(this.initialConfig);
  }
  /** Возвращает актуальный предел из конфигурации без изменения снимков существующих задач. */
  async currentIterationLimit(): Promise<number> {
    return (await this.currentConfig()).value.limits.turns;
  }
  /** Создаёт запуск или возвращает прежний результат идентичного запроса. */
  async create(input: RunInput): Promise<{ run: RunRecord; created: boolean }> {
    const request = runInputSchema.parse(input);
    this.store.assertRequestAllowed(request.requestKey, request.sessionId);
    const requestHash = hash(request);
    const previous = this.store.list(true).find((run) => run.requestKey === request.requestKey);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new Error('Idempotency key reused with different arguments');
      return { run: previous, created: false };
    }
    const config = await this.currentConfig();
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
    const agent = newAgent(config.value.defaultRole, request.message);
    let parentRunId: string | undefined;
    if (request.sessionId) {
      const sessionRuns = this.store
        .list(true)
        .filter((run) => run.sessionId === request.sessionId);
      if (sessionRuns.some((run) => Object.values(run.invocations).some(requiresOutcomeReview)))
        throw new Error(
          'В этой беседе осталась операция с неизвестным результатом. Сначала проверьте её в действиях исходной задачи.',
        );
      const last = sessionRuns.filter((run) => !run.deletedAt).at(-1);
      if (!last) throw new Error('Unknown session');
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
        ...this.humanResolutions(sessionRuns),
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
      ...(config.value.coordination === 'auto' ? { coordination: { attempts: 0 } } : {}),
      workspace,
      profile,
      config,
      learningVersion: this.learning.read().activeVersion,
      status: 'running',
      rootAgentId: agent.id,
      agents: { [agent.id]: agent },
      invocations: {},
      approvals: {},
      artifacts: [],
      turns: 0,
      iterationLimit: await this.iterations.defaultLimit(config.value.limits.turns),
      iterationStart: 0,
      handoffs: 0,
      usage: { input: 0, output: 0 },
      createdAt: new Date().toISOString(),
    };
    const created = await this.store.create(run);
    return { run: created, created: created.id === run.id };
  }

  /** Поздняя проверка скрытого этапа попадает в новый ход после завершения обменов инструментами. */
  private humanResolutions(runs: RunRecord[]): ChatMessage[] {
    const facts = runs.flatMap((run) => {
      const resolved = new Set(
        this.store
          .history(run.id, 0)
          .filter((event) => event.type === 'tool.human_resolved')
          .map((event) => z.object({ invocationId: z.string() }).parse(event.payload).invocationId),
      );
      return [...resolved].flatMap((invocationId) => {
        const invocation = run.invocations[invocationId];
        if (!invocation || !['succeeded', 'error'].includes(invocation.status)) return [];
        return [
          {
            runId: run.id,
            tool: invocation.call.name,
            callId: invocation.call.id,
            status: invocation.status,
            result: invocation.result,
          },
        ];
      });
    });
    return facts.length
      ? [
          {
            role: 'user',
            content:
              '[Harness: результаты прерванных операций, проверенные пользователем]\n' +
              JSON.stringify(facts),
          },
        ]
      : [];
  }
}
