import { z } from 'zod';

export const phaseSchema = z.enum([
  'run',
  'pause',
  'agent',
  'planning',
  'compaction',
  'model.queue',
  'model.request',
  'model.first_output',
  'model.retry',
  'tool.queue',
  'tool.execute',
  'approval',
  'children',
]);
export const outcomeSchema = z.enum(['completed', 'failed', 'cancelled', 'interrupted']);
const count = z.number().finite().nonnegative();
const identifier = z.string().min(1).max(256);
export const usageSchema = z
  .object({
    input: count.nullable(),
    output: count.nullable(),
    source: z.enum(['provider', 'estimate', 'unavailable']),
  })
  .strict();
export const activityEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    seq: count.int(),
    at: z.string().datetime(),
    processId: z.string().uuid(),
    runId: z.string().uuid(),
    agentId: z.string().uuid(),
    role: identifier,
    profile: identifier,
    episodeId: z.string().uuid(),
    requestId: identifier.optional(),
    invocationId: identifier.optional(),
    attempt: count.int().optional(),
    type: z.enum(['start', 'end', 'usage', 'gap']),
    spanId: z.string().uuid().optional(),
    phase: phaseSchema.optional(),
    durationMs: count.optional(),
    outcome: outcomeSchema.optional(),
    usage: usageSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const interval = event.type === 'start' || event.type === 'end';
    if (
      interval !== !!(event.spanId && event.phase) ||
      (event.type === 'end') !== (event.durationMs !== undefined && event.outcome !== undefined) ||
      (event.type === 'usage') !== (event.usage !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Поля не соответствуют типу события измерений.',
      });
  });
export type ActivityEvent = z.infer<typeof activityEventSchema>;
const usageGroup = z.object({ input: count, output: count, requests: count });
export const usageTotalsSchema = z.object({
  provider: usageGroup,
  estimate: usageGroup,
  unavailable: count,
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
export const phaseTotalsSchema = z.record(phaseSchema, count);
export const roleMetricsSchema = z.object({
  agentId: z.string(),
  episodeId: z.string(),
  role: z.string(),
  profile: z.string(),
  phases: phaseTotalsSchema,
  usage: usageTotalsSchema,
  retries: count,
  interrupted: count,
});
export type RoleMetrics = z.infer<typeof roleMetricsSchema>;
export const activityAggregateSchema = z.object({
  count: count,
  firstAt: z.string().optional(),
  lastAt: z.string().optional(),
  activeMs: count,
  pauseMs: count,
  usage: usageTotalsSchema,
  retries: count,
  partial: z.boolean(),
  roles: z.array(roleMetricsSchema),
  open: z.array(activityEventSchema),
});
export type ActivityAggregate = z.infer<typeof activityAggregateSchema>;
export const runInsightsSchema = z.object({
  runId: z.string(),
  status: z.string(),
  profile: z.string(),
  completeness: z.enum(['complete', 'partial', 'unavailable']),
  activeMs: count,
  pauseMs: count,
  usage: usageTotalsSchema,
  retries: count,
  legacyUsage: z.object({ input: count, output: count }),
  roles: z.array(roleMetricsSchema),
  roleCount: count.optional(),
  rolesTruncated: z.boolean().optional(),
  agentOffset: count.optional(),
  agentTotal: count.optional(),
  agents: z.array(
    z.object({
      id: z.string(),
      parentId: z.string().optional(),
      depth: count.optional(),
      role: z.string(),
      profile: z.string(),
      task: z.string(),
      taskTruncated: z.boolean().optional(),
      resultTruncated: z.boolean().optional(),
      errorTruncated: z.boolean().optional(),
      resultCursor: count.optional(),
      resultLength: count.optional(),
      status: z.string(),
      result: z.string().optional(),
      error: z.string().optional(),
      phases: z.array(phaseSchema),
      elapsedMs: count,
      reason: z.string().optional(),
    }),
  ),
});
export type RunInsights = z.infer<typeof runInsightsSchema>;
