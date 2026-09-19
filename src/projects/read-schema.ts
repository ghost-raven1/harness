import { z } from 'zod';
import { projectReportSchema, stageStatusSchema, versionedPlanSchema } from './schema.js';

const projectId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const count = z.number().int().nonnegative().safe();
const revision = count;
export const checkStateSchema = z.enum([
  'not_run',
  'running',
  'completed',
  'denied',
  'cancelled',
  'unknown',
  'unavailable',
]);
export const evidenceCheckSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  title: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  state: checkStateSchema,
  exitCode: z.number().nullable().optional(),
  evidence: z.enum(['available', 'pending', 'unavailable']),
  reason: z.string().optional(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
});
export const evidenceReportSchema = projectReportSchema.omit({ checks: true }).extend({
  checks: z.array(evidenceCheckSchema),
  planVersion: count.optional(),
  current: z.boolean(),
});
export const projectReviewSchema = z.object({
  projectId,
  revision,
  title: z.string(),
  goal: z.string(),
  acceptedVersion: count.optional(),
  plan: versionedPlanSchema.optional(),
  checkedAt: z.string(),
  freshness: z.enum(['current', 'changed', 'unavailable', 'not_checked']),
  freshnessReason: z.string().optional(),
  canAccept: z.boolean(),
  blockers: z.array(z.string()),
  stages: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      expected: z.string(),
      received: z.string(),
      status: stageStatusSchema,
      attempt: count,
      runId: z.string().optional(),
      verification: z.enum(['commands', 'manual']),
      manualInstructions: z.string().optional(),
      confirmed: z.boolean(),
      inheritedEvidence: z.boolean().optional(),
      reportIds: z.array(z.string()),
    }),
  ),
  reports: z.array(evidenceReportSchema),
  changes: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'modified', 'deleted']) })),
  changesTruncated: z.boolean(),
});
export const projectReadInputs = {
  reports: z
    .object({
      projectId,
      phase: z.enum(['baseline', 'stage', 'final']).optional(),
      stageId: z.string().optional(),
      attempt: count.optional(),
      offset: count.default(0),
      limit: count.min(1).max(50).default(20),
    })
    .strict(),
  checkOutput: z
    .object({
      projectId,
      reportId: z.string(),
      checkId: z.string(),
      stream: z.enum(['stdout', 'stderr']),
      offset: count.default(0),
    })
    .strict(),
  review: z.object({ projectId }).strict(),
  exportPreview: z
    .object({
      projectId,
      expectedRevision: revision,
      format: z.enum(['markdown', 'json']).default('markdown'),
      includeLogs: z.boolean().default(false),
    })
    .strict(),
  exportReport: z
    .object({
      projectId,
      expectedRevision: revision,
      previewToken: z.string().regex(/^[a-f0-9]{64}$/),
      requestKey: z.string().min(1).max(200),
      format: z.enum(['markdown', 'json']).default('markdown'),
      includeLogs: z.boolean().default(false),
    })
    .strict(),
};
export const projectReadOutputs = {
  reports: z.object({
    projectId,
    revision,
    items: z.array(evidenceReportSchema),
    total: count,
    nextOffset: count.optional(),
  }),
  checkOutput: z.object({
    projectId,
    reportId: z.string(),
    checkId: z.string(),
    stream: z.enum(['stdout', 'stderr']),
    exitCode: z.number().nullable().optional(),
    state: checkStateSchema,
    evidence: z.enum(['available', 'pending', 'unavailable']),
    reason: z.string().optional(),
    text: z.string(),
    offset: count,
    nextOffset: count.optional(),
    totalCharacters: count,
    truncated: z.boolean(),
    complete: z.boolean(),
  }),
  review: projectReviewSchema,
  exportPreview: z.object({
    projectId,
    revision,
    previewToken: z.string(),
    format: z.enum(['markdown', 'json']),
    includeLogs: z.boolean(),
    sections: z.array(z.string()),
    commands: z.array(z.object({ command: z.string(), args: z.array(z.string()) })),
    logs: z.array(
      z.object({
        reportId: z.string(),
        checkId: z.string(),
        stdoutCharacters: count,
        stderrCharacters: count,
        stdoutTruncated: z.boolean(),
        stderrTruncated: z.boolean(),
        available: z.boolean(),
        stdoutPreview: z.string().optional(),
        stderrPreview: z.string().optional(),
      }),
    ),
    destination: z.string(),
    warnings: z.array(z.string()),
  }),
  exportReport: z.object({
    projectId,
    revision,
    path: z.string(),
    format: z.enum(['markdown', 'json']),
    includeLogs: z.boolean(),
    bytes: count,
  }),
};
export type ProjectReview = z.infer<typeof projectReviewSchema>;
export type EvidenceReport = z.infer<typeof evidenceReportSchema>;
export type EvidenceCheck = z.infer<typeof evidenceCheckSchema>;
