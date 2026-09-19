import { z } from 'zod';

const key = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => !['__proto__', 'constructor', 'prototype'].includes(value),
    'Недопустимый идентификатор',
  );
const revision = z.number().int().nonnegative().safe();
export const projectStatusSchema = z.enum([
  'draft',
  'planning',
  'ready',
  'running',
  'pausing',
  'paused',
  'review',
  'completed',
  'cancelled',
]);
export const projectCheckSchema = z
  .object({
    id: key,
    title: z.string().min(1).max(500),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(16000)).max(100).default([]),
  })
  .strict();
export const projectStageSchema = z
  .object({
    id: key,
    title: z.string().min(1).max(500),
    task: z.string().min(1).max(32000),
    role: key,
    dependsOn: z.array(key).max(32).default([]),
    expectedResult: z.string().min(1).max(8000),
    requiredTools: z.array(key).max(32).default([]),
    verification: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('commands'), checks: z.array(projectCheckSchema).min(1).max(16) })
        .strict(),
      z.object({ kind: z.literal('manual'), instructions: z.string().min(1).max(8000) }).strict(),
    ]),
  })
  .strict();
export const projectPlanSchema = z
  .object({
    stages: z.array(projectStageSchema).min(1).max(32),
    maxCorrections: z.number().int().min(0).max(10).default(2),
    fixBaselineFailures: z.boolean().default(false),
  })
  .strict();
export const versionedPlanSchema = projectPlanSchema.extend({ version: revision.positive() });
export const stageStatusSchema = z.enum([
  'pending',
  'running',
  'checking',
  'manual',
  'completed',
  'blocked',
]);
export const projectReportSchema = z.object({
  id: key,
  phase: z.enum(['baseline', 'stage', 'final']),
  stageId: key.optional(),
  attempt: revision,
  runId: key.optional(),
  at: z.string(),
  status: z.enum(['passed', 'failed', 'unknown', 'manual']),
  workspaceRevision: z.string(),
  checks: z.array(
    z.object({
      id: key,
      title: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      status: z.string(),
      invocationId: z.string().optional(),
      exitCode: z.number().nullable().optional(),
      artifactId: z.string().optional(),
      summary: z.string().optional(),
    }),
  ),
  note: z.string().optional(),
});
export const projectActionSchema = z.enum([
  'plan',
  'editPlan',
  'acceptPlan',
  'pause',
  'resume',
  'cancel',
  'message',
  'manualCheck',
  'recheck',
  'accept',
  'archive',
  'purge',
  'resolve',
]);
export const projectSummarySchema = z.object({
  projectId: key,
  title: z.string(),
  goal: z.string(),
  workspace: z.string(),
  profile: key,
  revision,
  status: projectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().optional(),
  reason: z.string().optional(),
  reasonCode: z.string().optional(),
  currentRunId: key.optional(),
  currentStageId: key.optional(),
  attention: z
    .object({
      code: z.string(),
      reason: z.string(),
      action: z.enum([
        'resolve',
        'approvals',
        'acceptPlan',
        'manualCheck',
        'review',
        'resume',
        'inspect',
      ]),
      priority: revision,
      retryAt: z.string().optional(),
      runId: key.optional(),
      stageId: key.optional(),
    })
    .optional(),
  progress: z.object({
    total: revision,
    completed: revision,
    running: revision,
    blocked: revision,
  }),
});
export const projectEventSchema = z.object({
  seq: revision,
  at: z.string(),
  type: z.string(),
  message: z.string(),
});
export const projectViewSchema = projectSummarySchema.extend({
  plan: versionedPlanSchema.optional(),
  planVersion: revision.optional(),
  acceptedVersion: revision.optional(),
  resultRevision: z.string().optional(),
  currentRunId: key.optional(),
  pendingApprovals: revision.optional(),
  reason: z.string().optional(),
  reasonCode: z.string().optional(),
  allowedActions: z.array(projectActionSchema),
  roles: z.array(z.object({ id: key, label: z.string() })),
  tools: z.array(z.string()).optional(),
  stages: z.array(
    z.object({
      stageId: key,
      title: z.string(),
      status: stageStatusSchema,
      attempt: revision,
      runId: key.optional(),
      sessionId: key.optional(),
      summary: z.string().optional(),
      manualRevision: z.string().optional(),
    }),
  ),
  reports: z.array(projectReportSchema),
  changes: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'modified', 'deleted']) })),
  changesTruncated: z.boolean(),
  externalChanges: z
    .array(z.object({ path: z.string(), kind: z.enum(['added', 'modified', 'deleted']) }))
    .optional(),
  externalChangesTruncated: z.boolean().optional(),
  blockers: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      runId: key.optional(),
      stageId: key.optional(),
    }),
  ),
  events: z.object({ items: z.array(projectEventSchema), cursor: revision, hasMore: z.boolean() }),
});
export const projectListSchema = z.object({
  items: z.array(projectSummarySchema),
  total: revision,
  page: revision,
  pages: revision.positive(),
  attentionCount: revision.optional(),
});
export const projectPurgePreviewSchema = z.object({
  projectId: key,
  previewToken: z.string(),
  available: z.boolean(),
  blockers: z.array(z.string()),
  runs: revision,
  sessions: revision,
  artifacts: revision,
});

const projectId = z.object({ projectId: key }).strict();
const mutation = projectId.extend({ expectedRevision: revision, requestKey: key }).strict();
/** Локальные команды используют один контракт на обеих сторонах IPC. */
export const projectInputs = {
  create: z
    .object({
      title: z.string().min(1).max(500),
      goal: z.string().min(1).max(32000),
      workspace: z.string().min(1),
      profile: key.optional(),
      requestKey: key,
    })
    .strict(),
  list: z
    .object({
      query: z.string().max(200).default(''),
      page: revision.default(0),
      limit: revision.min(1).max(50).default(10),
      includeArchived: z.boolean().default(false),
      attentionOnly: z.boolean().optional(),
    })
    .strict(),
  detail: projectId.extend({
    cursor: revision.default(0),
    eventLimit: revision.min(1).max(100).default(30),
  }),
  plan: mutation.extend({
    feedback: z.string().max(16000).optional(),
    goal: z.string().min(1).max(32000).optional(),
  }),
  editPlan: mutation.extend({ plan: projectPlanSchema }),
  acceptPlan: mutation.extend({ expectedPlanVersion: revision.positive() }),
  pause: mutation,
  resume: mutation.extend({ acceptChanges: z.boolean().default(false) }),
  cancel: mutation,
  message: mutation.extend({ stageId: key, message: z.string().min(1).max(32000) }),
  manualCheck: mutation.extend({
    stageId: key,
    expectedResultRevision: z.string().min(1),
    outcome: z.enum(['passed', 'failed']),
    comment: z.string().max(8000).default(''),
  }),
  recheck: mutation,
  accept: mutation.extend({ expectedResultRevision: z.string().min(1) }),
  archive: mutation.extend({ archived: z.boolean().default(true) }),
  resolve: mutation.extend({
    runId: key,
    invocationId: key,
    result: z.string().max(1000000),
    succeeded: z.boolean(),
  }),
  purgePreview: projectId,
  purge: mutation.extend({ previewToken: z.string().min(1) }),
};
