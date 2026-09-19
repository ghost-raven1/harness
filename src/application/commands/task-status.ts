import { z } from 'zod';
import type { Application } from '../bootstrap.js';
import { requiresOutcomeReview } from '../../sessions/invocations.js';
import { resultCursorSchema, resultFields } from '../result-pages.js';
export const runIdSchema = z.object({ runId: z.string().uuid() }).strict();
export const statusInputSchema = z
  .object({
    runId: z.string().uuid(),
    cursor: z.number().int().min(0).default(0),
    waitMs: z.number().int().min(0).max(25000).default(0),
    resultCursor: resultCursorSchema.optional(),
  })
  .strict();

/** Собирает состояние задачи и независимые страницы событий и итогового ответа. */
export async function runStatus(
  app: Application,
  runId: string,
  cursor = 0,
  resultCursor?: number,
): Promise<Record<string, unknown>> {
  const loaded = await app.sessions.load(runId);
  const run = app.runtime.view(runId, loaded);
  const events = await app.sessions.history(runId, cursor, 100);
  return {
    runId,
    task: run.agents[run.rootAgentId]?.task,
    createdAt: run.createdAt,
    deletedAt: run.deletedAt,
    sessionId: run.sessionId,
    project: run.project,
    status: run.status,
    recoveryRequired: run.recoveryRequired,
    pendingMessages: run.userMessages?.filter((item) => !item.deliveredAt).length ?? 0,
    ...resultFields(run.result, resultCursor),
    error: run.error,
    pauseReason: run.pauseReason,
    providerPause: run.providerPause,
    workspace: run.workspace,
    profile: run.profile,
    turns: run.turns,
    iterations: app.runtime.runIterationStatus(runId, run),
    usage: run.usage,
    budget: await app.runtime.usage.status(runId),
    learningVersion: run.learningVersion,
    artifacts: run.artifacts ?? [],
    fileChanges: (run.fileChanges ?? []).map(({ canonical: _canonical, ...change }) => change),
    agents: Object.values(run.agents).map((agent) => ({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      parentId: agent.parentId,
    })),
    approvals:
      !run.recoveryRequired && ['running', 'awaiting_approval', 'paused'].includes(run.status)
        ? Object.values(run.approvals).filter((item) => item.status === 'pending')
        : [],
    unknownInvocations: Object.values(run.invocations)
      .filter(
        (item) =>
          item.status === 'unknown' || (!app.runtime.busy(runId) && requiresOutcomeReview(item)),
      )
      .map((item) => ({
        id: item.id,
        tool: item.call.name,
        arguments: item.call.arguments,
        result: item.result,
      })),
    cursor: events.at(-1)?.seq ?? cursor,
    events: events.map(({ seq, at, type, payload }) => ({ seq, at, type, payload })),
    hasMoreEvents: (await app.sessions.history(runId, events.at(-1)?.seq ?? cursor, 1)).length > 0,
  };
}
