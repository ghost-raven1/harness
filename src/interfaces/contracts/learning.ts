import { z } from 'zod';
import { command, count, empty, runId } from './common.js';

export const candidateStatusSchema = z.enum([
  'candidate',
  'evaluating',
  'published',
  'rejected',
  'revoked',
]);
export const candidateSchema = z.object({
  id: z.string(),
  sourceRunId: z.string(),
  workspace: z.string(),
  role: z.string(),
  profile: z.string(),
  title: z.string(),
  lesson: z.string(),
  appliesWhen: z.string(),
  evidenceIds: z.array(z.string()),
  status: candidateStatusSchema,
  reason: z.string().optional(),
  fingerprint: z.string(),
});
export const evidenceSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string(),
  role: z.string(),
  kind: z.enum(['tool', 'feedback']),
  content: z.string(),
  verified: z.boolean(),
});
export const reportSchema = z.object({
  candidateId: z.string(),
  baselineVersion: z.string(),
  suiteHash: z.string(),
  results: z.array(
    z.object({
      caseId: z.string(),
      variant: z.enum(['baseline', 'candidate']),
      repetition: count,
      passed: z.boolean(),
      detail: z.string(),
    }),
  ),
  passed: z.boolean().optional(),
  reason: z.string().optional(),
});
export const releaseSchema = z.object({
  id: z.string(),
  parentId: z.string().optional(),
  createdAt: z.string(),
  candidateIds: z.array(z.string()),
  revoked: z.boolean().optional(),
  reason: z.string().optional(),
});
export const jobSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: z.string(),
  candidateId: z.string().optional(),
  feedbackId: z.string().optional(),
  status: z.enum(['queued', 'done', 'inactive']),
  error: z.string().optional(),
  retryAt: z.string().optional(),
});
export const learningStatusSchema = z.object({
  activeVersion: z.string(),
  activeCandidateIds: z.array(z.string()).optional(),
  releases: z.array(releaseSchema).optional(),
  evaluationReady: z.boolean().optional(),
  controlCases: count.optional(),
  enabled: z.boolean(),
  paused: z.boolean(),
  dailyLimit: z.null(),
  daily: z.object({ date: z.string(), tokens: count }),
  jobs: z.array(jobSchema),
  candidates: z.array(
    candidateSchema.pick({ id: true, title: true, status: true, reason: true }).extend({
      workspace: z.string().optional(),
      role: z.string().optional(),
      profile: z.string().optional(),
    }),
  ),
});
export const learningInspectSchema = z.object({
  candidate: candidateSchema,
  // JSON представляет отсутствующий элемент массива как null; клиент сохраняет прежний контракт undefined.
  evidence: z.array(evidenceSchema.nullish().transform((item) => item ?? undefined)),
  report: reportSchema.optional(),
});

export const learningCommands = {
  'learning.status': command(empty, learningStatusSchema),
  'learning.inspect': command(z.object({ id: z.string() }).strict(), learningInspectSchema),
  'learning.export': command(
    z.object({ id: z.string().uuid() }).strict(),
    z.object({ path: z.string(), exists: z.boolean().optional() }),
  ),
  'learning.feedback': command(
    runId.extend({
      positive: z.boolean(),
      text: z.string().min(1),
      candidateId: z.string().optional(),
    }),
    z.object({ recorded: z.literal(true) }),
  ),
  'learning.rollback': command(
    z.object({ reason: z.string().min(1) }).strict(),
    z.object({ rolledBack: z.literal(true) }),
  ),
  'learning.pause': command(empty, z.object({ paused: z.literal(true) })),
  'learning.resume': command(empty, z.object({ paused: z.literal(false) })),
};
