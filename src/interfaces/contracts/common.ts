import { z } from 'zod';

export const empty = z.object({}).strict();
export const count = z.number().int().nonnegative().safe();
export const runId = z.object({ runId: z.string().uuid() }).strict();
export const optionalRunId = z.object({ runId: z.string().uuid().optional() }).strict();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Объединяет обе схемы; тип клиента выводится из реестра, а не задаётся вызывающим кодом. */
export function command<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(params: I, response: O) {
  return { params, response };
}

export const approvalSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    agentId: z.string(),
    callId: z.string(),
    binding: z.string(),
    previewToken: z.string().optional(),
    tool: z.string(),
    args: z.unknown(),
    reason: z.string(),
    status: z.enum(['pending', 'allowed', 'denied', 'consumed', 'cancelled']),
  })
  .transform((value) => ({ ...value, args: value.args }));
export const resultPageSchema = z.object({
  text: z.string(),
  cursor: count,
  nextCursor: count,
  total: count,
  hasMore: z.boolean(),
});
export const runStatusSchema = z.enum([
  'running',
  'awaiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export const iterationProgressSchema = z.object({
  limit: count,
  used: count,
  total: count,
  remaining: count,
  pausedByLimit: z.boolean(),
  editable: z.boolean(),
});
export const iterationsSchema = z.object({
  defaultLimit: count,
  run: iterationProgressSchema.optional(),
});
export const budgetSchema = z.object({
  date: z.string(),
  daily: z.object({
    tasks: count,
    learning: count,
    reportedTasks: count,
    reportedLearning: count,
    extra: count,
  }),
  dailyLimit: z.null(),
  runReserved: count,
  runLimit: z.null(),
  warning: z.boolean(),
});
export const fileChangeSchema = z.object({
  id: z.string(),
  path: z.string(),
  beforeHash: z.string(),
  afterHash: z.string(),
  existed: z.boolean(),
  status: z.enum(['prepared', 'applied', 'restoring', 'restored', 'reviewed']),
  resolution: z.object({ at: z.string(), result: z.string() }).optional(),
  invocationId: z.string().optional(),
});
export const eventSchema = z
  .object({
    seq: count,
    at: z.string().optional(),
    type: z.string(),
    payload: z.unknown(),
    role: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
    preview: z.object({ text: z.string(), reasoning: z.string().optional() }).optional(),
  })
  .transform((value) => ({ ...value, payload: value.payload }));
export const outputEventSchema = z.object({
  seq: count,
  at: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  role: z.string(),
  type: z.enum(['started', 'text', 'reasoning', 'retry', 'completed', 'failed', 'truncated']),
  text: z.string().max(4096).optional(),
});
