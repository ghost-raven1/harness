import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hash } from '../shared/primitives.js';
import { writeDerivedText } from './files.js';
import { requiresOutcomeReview } from './invocations.js';
import type { RunRecord } from './types.js';
import type { RunCatalogEntry } from './ports.js';
import { approvalSchema } from './validation.js';
import { projectRunLinkSchema } from './project-run.js';

export const catalogEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  requestKey: z.string(),
  requestHash: z.string(),
  parentRunId: z.string().optional(),
  project: projectRunLinkSchema.optional(),
  workspace: z.string(),
  profile: z.string(),
  task: z.string(),
  taskTruncated: z.boolean().optional(),
  status: z.enum(['running', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled']),
  pauseReason: z.enum(['iterations', 'provider', 'project']).optional(),
  providerPause: z
    .object({ kind: z.enum(['rate_limit', 'quota']), retryAt: z.string().optional() })
    .optional(),
  deletedAt: z.string().optional(),
  createdAt: z.string(),
  seq: z.number().int().positive(),
  rootAgentId: z.string(),
  learningVersion: z.string(),
  turns: z.number(),
  usage: z.object({ input: z.number(), output: z.number() }),
  unknownOutcome: z.boolean(),
  unfinishedOperations: z.boolean(),
  pendingApprovals: z.array(approvalSchema),
  approvalIds: z.array(z.string()),
  artifacts: z.array(z.object({ id: z.string(), agentId: z.string(), callId: z.string() })),
  searchHash: z.string(),
  learningEnabled: z.boolean(),
});

/** Отбирает только данные для меню, поиска и проверок перед запуском. */
export function catalogEntry(run: RunRecord, seq: number): RunCatalogEntry {
  return {
    id: run.id,
    sessionId: run.sessionId,
    requestKey: run.requestKey,
    requestHash: run.requestHash,
    parentRunId: run.parentRunId,
    project: run.project,
    workspace: run.workspace,
    profile: run.profile,
    task: run.agents[run.rootAgentId]!.task.slice(0, 1000),
    ...(run.agents[run.rootAgentId]!.task.length > 1000 ? { taskTruncated: true } : {}),
    status: run.status,
    pauseReason: run.pauseReason,
    providerPause: run.providerPause,
    deletedAt: run.deletedAt,
    createdAt: run.createdAt,
    seq,
    rootAgentId: run.rootAgentId,
    learningVersion: run.learningVersion,
    turns: run.turns,
    usage: run.usage,
    unfinishedOperations: Object.values(run.invocations).some((item) => item.status === 'started'),
    unknownOutcome:
      Object.values(run.invocations).some(requiresOutcomeReview) ||
      !!run.fileChanges?.some((change) => change.status === 'restoring'),
    approvalIds: Object.keys(run.approvals),
    pendingApprovals: ['running', 'awaiting_approval', 'paused'].includes(run.status)
      ? Object.values(run.approvals).filter((item) => item.status === 'pending')
      : [],
    artifacts: run.artifacts,
    searchHash: hash(searchText(run)),
    learningEnabled: run.config.value.learning.enabled,
  };
}

/** Полный ответ индексируется отдельно и не попадает в общий каталог. */
export function searchText(run: RunRecord): string {
  return [run.id, run.workspace, run.profile, run.agents[run.rootAgentId]!.task, run.result ?? '']
    .join('\n')
    .toLocaleLowerCase();
}

/** Производный поиск проверяет отпечаток; повреждённый файл восстанавливается из состояния. */
export class HistorySearch {
  private revision = 0;
  private readonly cached = new Map<string, { revision: number; ids: Set<string> }>();
  constructor(
    private readonly directory: string,
    private readonly load: (id: string) => Promise<RunRecord>,
    private readonly persist: (run: RunRecord) => Promise<void>,
  ) {}
  /** Любое изменение каталога сбрасывает результаты прежних запросов. */
  invalidate(): void {
    this.revision++;
    this.cached.clear();
  }
  /** Ошибка индекса не меняет исход подтверждённого события. */
  async save(run: RunRecord, strict = false): Promise<void> {
    try {
      await writeDerivedText(join(this.directory, 'search', run.id + '.txt'), searchText(run));
    } catch (error) {
      if (strict) throw error;
      /* При поиске отсутствующие данные будут построены заново. */
    }
  }
  /** Кэширует только идентификаторы совпадений для восьми последних запросов. */
  async match(entries: RunCatalogEntry[], query: string): Promise<Set<string>> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return new Set(entries.map((item) => item.id));
    const cached = this.cached.get(needle);
    if (cached?.revision === this.revision) return cached.ids;
    const revision = this.revision;
    const ids = new Set<string>();
    for (const entry of entries) {
      let text: string | undefined;
      try {
        text = await readFile(join(this.directory, 'search', entry.id + '.txt'), 'utf8');
      } catch {
        /* Восстановим из источника. */
      }
      if (text === undefined || hash(text) !== entry.searchHash) {
        const run = await this.load(entry.id);
        text = searchText(run);
        await this.persist(run);
      }
      if (text.includes(needle)) ids.add(entry.id);
    }
    if (this.cached.size >= 8) this.cached.delete(this.cached.keys().next().value!);
    if (revision === this.revision) this.cached.set(needle, { revision, ids });
    return ids;
  }
}
