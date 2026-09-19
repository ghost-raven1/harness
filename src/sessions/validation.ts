import { z } from 'zod';
import { configSchema } from '../configuration/schema.js';
import type { JournalEvent, RunRecord } from './types.js';

const text = z.string();
const natural = z.number().int().nonnegative().safe();
export const toolCallSchema = z
  .object({ id: text.min(1), name: text.min(1), arguments: text })
  .passthrough();
const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: text,
    toolCalls: z.array(toolCallSchema).optional(),
    toolCallId: text.optional(),
    reasoning: text.optional(),
    reasoningSignature: text.optional(),
    redactedReasoning: z.array(text).optional(),
  })
  .passthrough();
export const agentSchema = z
  .object({
    id: text.min(1),
    parentId: text.optional(),
    role: text.min(1),
    authorityRoles: z.array(text),
    depth: natural,
    task: text,
    status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled']),
    messages: z.array(messageSchema),
    summary: text,
    result: text.optional(),
    error: text.optional(),
    pending: z.array(toolCallSchema).optional(),
    completedCalls: z.array(text),
    children: z.array(text),
    collectedChildren: z.array(text),
  })
  .passthrough();
export const invocationSchema = z
  .object({
    id: text.min(1),
    agentId: text.min(1),
    role: text.optional(),
    call: toolCallSchema,
    effect: z.enum(['read', 'write', 'control']),
    status: z.enum(['started', 'succeeded', 'error', 'denied', 'cancelled', 'unknown']),
    result: text.optional(),
    error: text.optional(),
    startedAt: text,
    finishedAt: text.optional(),
  })
  .passthrough();
export const approvalSchema = z
  .object({
    id: text.min(1),
    runId: text.min(1),
    agentId: text.min(1),
    callId: text.min(1),
    binding: text,
    previewToken: text.optional(),
    tool: text,
    args: z.unknown(),
    reason: text,
    status: z.enum(['pending', 'allowed', 'denied', 'consumed', 'cancelled']),
  })
  .passthrough();
export const fileChangeSchema = z
  .object({
    id: text.min(1),
    path: text,
    canonical: text,
    beforeHash: text,
    afterHash: text,
    existed: z.boolean(),
    status: z.enum(['prepared', 'applied', 'restoring', 'restored', 'reviewed']),
    resolution: z.object({ at: text, result: text }).optional(),
    invocationId: text.optional(),
  })
  .passthrough();
export const runRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: text.min(1),
    sessionId: text.min(1),
    requestKey: text,
    requestHash: text,
    parentRunId: text.optional(),
    workspace: text,
    profile: text,
    config: z.object({ hash: text, value: configSchema }),
    learningVersion: text,
    status: z.enum(['running', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled']),
    rootAgentId: text,
    agents: z.record(agentSchema),
    invocations: z.record(invocationSchema),
    approvals: z.record(approvalSchema),
    artifacts: z.array(z.object({ id: text, agentId: text, callId: text })),
    fileChanges: z.array(fileChangeSchema).optional(),
    turns: natural,
    iterationLimit: natural.positive().optional(),
    iterationStart: natural.optional(),
    handoffs: natural,
    usage: z.object({ input: natural, output: natural }),
    createdAt: text,
    deletedAt: text.optional(),
    result: text.optional(),
    error: text.optional(),
    pauseReason: z.enum(['iterations', 'provider']).optional(),
    providerPause: z
      .object({ kind: z.enum(['rate_limit', 'quota']), retryAt: text.optional() })
      .optional(),
    userMessages: z
      .array(
        z.object({
          id: text,
          requestKey: text,
          content: text,
          receivedAt: text,
          deliveredAt: text.optional(),
        }),
      )
      .optional(),
    coordination: z
      .object({
        attempts: natural,
        plan: z
          .object({
            mode: z.enum(['direct', 'parallel', 'handoff']),
            reason: text,
            tasks: z.array(z.object({ role: text, task: text, context: text })),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

/** Проверяет данные и связи, возвращая исходный снимок без применения новых значений по умолчанию. */
export function validateRunRecord(value: unknown): RunRecord {
  runRecordSchema.parse(value);
  const run = value as RunRecord;
  const fail = (): never => {
    throw new Error('JOURNAL_INVALID_REFERENCE');
  };
  if (!run.agents[run.rootAgentId] || run.agents[run.rootAgentId]!.parentId) fail();
  for (const [key, agent] of Object.entries(run.agents)) {
    if (key !== agent.id || !run.config.value.roles[agent.role]) fail();
    if (agent.parentId && !run.agents[agent.parentId]?.children.includes(key)) fail();
    if (agent.children.some((child) => run.agents[child]?.parentId !== key)) fail();
    if (agent.collectedChildren.some((child) => !agent.children.includes(child))) fail();
    const ancestors = new Set([key]);
    let parent = agent.parentId;
    while (parent) {
      if (ancestors.has(parent)) fail();
      ancestors.add(parent);
      parent = run.agents[parent]?.parentId;
    }
  }
  for (const [key, invocation] of Object.entries(run.invocations))
    if (key !== invocation.id || !run.agents[invocation.agentId]) fail();
  for (const [key, approval] of Object.entries(run.approvals))
    if (key !== approval.id || approval.runId !== run.id || !run.agents[approval.agentId]) fail();
  for (const artifact of run.artifacts) if (!run.agents[artifact.agentId]) fail();
  return run;
}

/** Проверяет номер события и привязку к имени журнала до использования состояния. */
export function validateJournalEvent(
  value: unknown,
  sequence: number,
  runId: string,
): JournalEvent {
  const envelope = z
    .object({
      seq: natural.positive(),
      at: text,
      type: text.min(1),
      payload: z.unknown(),
      state: z.unknown(),
    })
    .parse(value);
  const state = validateRunRecord(envelope.state);
  if (envelope.seq !== sequence || state.id !== runId) throw new Error('JOURNAL_INVALID_SEQUENCE');
  return value as JournalEvent;
}
