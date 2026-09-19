import { z } from 'zod';
import { runInputSchema } from '../../runtime/run-factory.js';
import { runMessageSchema } from '../../runtime/messages.js';
import { projectRunLinkSchema } from '../../sessions/project-run.js';
import {
  command,
  count,
  runId,
  runStatusSchema,
  resultPageSchema,
  iterationProgressSchema,
  budgetSchema,
  approvalSchema,
  eventSchema,
  outputEventSchema,
  fileChangeSchema,
} from './common.js';

export const statusInputSchema = runId.extend({
  cursor: count.default(0),
  waitMs: count.max(25000).default(0),
  resultCursor: count.optional(),
});
export const statusSchema = z
  .object({
    runId: z.string(),
    project: projectRunLinkSchema.optional(),
    task: z.string().optional(),
    createdAt: z.string().optional(),
    deletedAt: z.string().optional(),
    sessionId: z.string(),
    workspace: z.string(),
    status: runStatusSchema,
    recoveryRequired: z.boolean().optional(),
    pendingMessages: count.optional(),
    profile: z.string(),
    turns: count,
    iterations: iterationProgressSchema.optional(),
    learningVersion: z.string(),
    result: z.string().optional(),
    resultTruncated: z.boolean().optional(),
    resultLength: count.optional(),
    resultPage: resultPageSchema.optional(),
    error: z.string().optional(),
    pauseReason: z.enum(['iterations', 'provider', 'project']).optional(),
    providerPause: z
      .object({ kind: z.enum(['rate_limit', 'quota']), retryAt: z.string().optional() })
      .optional(),
    cursor: count,
    usage: z.object({ input: count, output: count }),
    budget: budgetSchema.optional(),
    artifacts: z
      .array(z.object({ id: z.string(), agentId: z.string(), callId: z.string() }))
      .optional(),
    agents: z.array(
      z.object({
        id: z.string(),
        role: z.string(),
        status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled']),
        parentId: z.string().optional(),
      }),
    ),
    approvals: z.array(approvalSchema),
    events: z.array(eventSchema),
    hasMoreEvents: z.boolean().optional(),
    fileChanges: z.array(fileChangeSchema).optional(),
    unknownInvocations: z.array(
      z.object({
        id: z.string(),
        tool: z.string(),
        arguments: z.string().optional(),
        result: z.string().optional(),
      }),
    ),
  })
  .passthrough();
export const runSummarySchema = z.object({
  runId: z.string(),
  task: z.string(),
  taskTruncated: z.boolean().optional(),
  status: runStatusSchema,
  deletedAt: z.string().optional(),
  profile: z.string(),
  createdAt: z.string(),
  workspace: z.string().optional(),
});
export const taskSchema = statusSchema.extend({
  output: z.object({ events: z.array(outputEventSchema), cursor: count, hasMore: z.boolean() }),
});

export const taskCommands = {
  'runtime.run': command(runInputSchema, z.object({ runId: z.string(), sessionId: z.string() })),
  'runtime.message': command(
    runMessageSchema,
    z.object({
      runId: z.string(),
      sessionId: z.string(),
      messageId: z.string(),
      status: z.enum(['queued', 'delivered']),
    }),
  ),
  'runtime.status': command(statusInputSchema, statusSchema),
  'runtime.task': command(statusInputSchema.extend({ outputCursor: count.default(0) }), taskSchema),
  'runtime.result': command(runId.extend({ cursor: count.default(0) }), resultPageSchema),
  'runtime.cancel': command(runId, z.object({ cancelled: z.literal(true) })),
  'runtime.resume': command(runId, z.object({ resumed: z.literal(true) })),
  'runtime.delete': command(runId, z.object({ deleted: z.literal(true) })),
  'runtime.resolve': command(
    runId.extend({
      invocationId: z.string(),
      result: z.string().max(1000000),
      succeeded: z.boolean(),
    }),
    z.object({ resolved: z.literal(true) }),
  ),
  'runtime.list': command(
    z.object({ offset: count.default(0), limit: count.min(1).max(200).optional() }).strict(),
    z.array(runSummarySchema),
  ),
  'runtime.history': command(
    z
      .object({
        query: z.string().max(200).default(''),
        page: count.default(0),
        limit: count.min(1).max(50).default(10),
        includeDeleted: z.boolean().default(false),
      })
      .strict(),
    z.object({
      active: z.array(runSummarySchema),
      items: z.array(runSummarySchema),
      page: count,
      pages: count.min(1),
      total: count,
    }),
  ),
};
