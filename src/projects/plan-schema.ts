import { z } from 'zod';
import { projectPlanSchema, versionedPlanSchema } from './schema.js';
import { draftPlanSchema } from '../sessions/draft-payload.js';

const natural = z.number().int().nonnegative().safe();
const projectId = z.string().min(1).max(200);
export const planIssueSchema = z.object({
  path: z.array(z.union([z.string(), natural])),
  code: z.string(),
  message: z.string(),
});
export const planValidationSchema = z.object({
  projectId,
  revision: natural,
  valid: z.boolean(),
  stale: z.boolean(),
  issues: z.array(planIssueSchema),
  plan: projectPlanSchema.optional(),
  choices: z.object({
    roles: z.array(z.object({ id: z.string(), label: z.string() })),
    tools: z.array(z.string()),
  }),
  completedStageIds: z.array(z.string()),
});
export const planVersionSummarySchema = z.object({
  version: natural.positive(),
  revision: natural.positive(),
  createdAt: z.string(),
  accepted: z.boolean(),
  stageCount: natural,
});
export const planChangeSchema = z.object({
  kind: z.enum(['added', 'removed', 'changed', 'reordered']),
  stageId: z.string().optional(),
  checkId: z.string().optional(),
  field: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export const planComparisonSchema = z.object({
  projectId,
  revision: natural,
  fromVersion: natural.positive().optional(),
  toVersion: natural.positive().optional(),
  basis: z.enum(['accepted', 'previous', 'first', 'explicit', 'draft']),
  before: versionedPlanSchema.optional(),
  after: draftPlanSchema,
  changes: z.array(planChangeSchema),
});

/** Схемы чтения планов не зависят от транспорта и не дают модели права принять изменения. */
export const planReadCommands = {
  'projects.validatePlan': {
    params: z
      .object({ projectId, plan: z.unknown(), expectedRevision: natural.optional() })
      .strict(),
    response: planValidationSchema,
  },
  'projects.planVersions': {
    params: z
      .object({ projectId, offset: natural.default(0), limit: natural.min(1).max(50).default(20) })
      .strict(),
    response: z.object({
      projectId,
      revision: natural,
      items: z.array(planVersionSummarySchema),
      total: natural,
      nextOffset: natural.optional(),
      currentVersion: natural.positive().optional(),
      acceptedVersion: natural.positive().optional(),
    }),
  },
  'projects.comparePlans': {
    params: z
      .object({
        projectId,
        fromVersion: natural.positive().optional(),
        toVersion: natural.positive().optional(),
        plan: draftPlanSchema.optional(),
      })
      .strict(),
    response: planComparisonSchema,
  },
};
export type PlanIssue = z.infer<typeof planIssueSchema>;
export type PlanChange = z.infer<typeof planChangeSchema>;
export type PlanComparison = z.infer<typeof planComparisonSchema>;
