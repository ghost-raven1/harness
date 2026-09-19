import { projectChangeSetSchema } from './change-types.js';
import { projectCaptureSettingsSchema } from '../configuration/project-capture.js';
import { z } from 'zod';
import { configSchema } from '../configuration/schema.js';
import { hash } from '../shared/primitives.js';
import {
  projectCheckSchema,
  projectReportSchema,
  projectStatusSchema,
  stageStatusSchema,
  versionedPlanSchema,
} from './schema.js';
import type { ProjectEvent, ProjectRecord } from './types.js';

export const projectIdentifier = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const natural = z.number().int().nonnegative().safe();
const text = z.string();
const snapshot = z
  .object({ digest: text, ref: text, files: natural, createdAt: text, contentRef: text.optional() })
  .strict();
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: projectIdentifier,
    revision: natural.positive(),
    requestKey: text,
    requestHash: text,
    title: text,
    goal: text,
    workspace: text,
    profile: text,
    status: projectStatusSchema,
    createdAt: text,
    updatedAt: text,
    archivedAt: text.optional(),
    config: z.object({ hash: text, value: configSchema }),
    learningVersion: text,
    capture: projectCaptureSettingsSchema.optional(),
    changeSets: z.array(projectChangeSetSchema).optional(),
    plan: versionedPlanSchema.optional(),
    acceptedVersion: natural.positive().optional(),
    acceptedAt: text.optional(),
    stages: z.record(
      z
        .object({
          stageId: text,
          status: stageStatusSchema,
          attempt: natural,
          runId: text.optional(),
          sessionId: text.optional(),
          summary: text.optional(),
          manualRevision: text.optional(),
          definitionHash: text,
        })
        .strict(),
    ),
    runIds: z.array(text),
    reports: z.array(projectReportSchema),
    intent: z
      .object({
        kind: z.enum(['planning', 'stage', 'checks']),
        phase: z.enum(['baseline', 'stage', 'final']).optional(),
        stageId: text.optional(),
        attempt: natural,
        requestKey: text,
        message: text,
        runId: text.optional(),
        sessionId: text.optional(),
        expectedParentRunId: text.optional(),
        before: snapshot.optional(),
        changeSetId: text.optional(),
        checks: z.array(projectCheckSchema).optional(),
      })
      .strict()
      .optional(),
    baseline: snapshot.optional(),
    checkpoint: snapshot.optional(),
    resultSnapshot: snapshot.optional(),
    externalSnapshot: snapshot.optional(),
    phase: z.enum(['planning', 'baseline', 'stages', 'final', 'acceptance']),
    baselinePassed: z.boolean().optional(),
    reason: text.optional(),
    reasonCode: text.optional(),
    receipts: z.record(text),
    deletedAt: text.optional(),
    messages: z
      .array(
        z
          .object({
            requestKey: text,
            runId: text,
            stageId: text,
            message: text,
            sent: z.boolean().optional(),
            rejected: text.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** Проверяет исходный снимок и связи, не добавляя новые значения в историческую конфигурацию. */
export function validateProject(value: unknown): ProjectRecord {
  recordSchema.parse(value);
  const project = value as ProjectRecord;
  if (
    project.config.hash !== hash(project.config.value) ||
    !Object.hasOwn(project.config.value.profiles, project.profile)
  )
    throw new Error('PROJECT_INVALID_CONFIGURATION');
  if (Object.entries(project.stages).some(([id, stage]) => id !== stage.stageId))
    throw new Error('PROJECT_INVALID_STAGE_REFERENCE');
  if (project.acceptedVersion && project.acceptedVersion > (project.plan?.version ?? 0))
    throw new Error('PROJECT_INVALID_PLAN_REFERENCE');
  if (project.intent?.runId && !project.runIds.includes(project.intent.runId))
    throw new Error('PROJECT_INVALID_RUN_REFERENCE');
  const stages = project.plan?.stages ?? [];
  if (
    stages.length !== Object.keys(project.stages).length ||
    new Set(stages.map((stage) => stage.id)).size !== stages.length
  )
    throw new Error('PROJECT_INVALID_STAGE_REFERENCE');
  const visited = new Set<string>();
  for (const stage of stages) {
    const state = project.stages[stage.id];
    if (
      !state ||
      state.definitionHash !== hash(stage) ||
      !Object.hasOwn(project.config.value.roles, stage.role) ||
      stage.dependsOn.some((id) => !visited.has(id))
    )
      throw new Error('PROJECT_INVALID_STAGE_REFERENCE');
    visited.add(stage.id);
  }
  if (
    new Set(project.runIds).size !== project.runIds.length ||
    Object.values(project.stages).some(
      (stage) =>
        (stage.runId && !project.runIds.includes(stage.runId)) ||
        Boolean(stage.runId) !== Boolean(stage.sessionId),
    ) ||
    project.messages?.some((item) => !project.runIds.includes(item.runId))
  )
    throw new Error('PROJECT_INVALID_RUN_REFERENCE');
  if (project.changeSets) {
    const identities = new Set(project.changeSets.map((entry) => entry.id));
    if (
      identities.size !== project.changeSets.length ||
      project.changeSets.some(
        (entry) =>
          (entry.runId && !project.runIds.includes(entry.runId)) ||
          (entry.reportId &&
            !project.reports.some(
              (report) => report.id === entry.reportId && report.runId === entry.runId,
            )) ||
          (entry.outcome === 'complete' && !entry.after) ||
          (entry.outcome !== 'complete' && entry.after),
      ) ||
      (project.intent?.changeSetId && !identities.has(project.intent.changeSetId))
    )
      throw new Error('PROJECT_INVALID_CHANGE_REFERENCE');
  }
  const intent = project.intent;
  if (
    intent &&
    ((intent.kind === 'stage' && !visited.has(intent.stageId ?? '')) ||
      (intent.kind === 'checks' &&
        (!intent.phase ||
          !intent.before ||
          !intent.checks?.length ||
          (intent.phase === 'stage' && !visited.has(intent.stageId ?? '')))))
  )
    throw new Error('PROJECT_INVALID_INTENT');
  return project;
}

export interface ProjectJournalEvent extends ProjectEvent {
  schemaVersion: 1;
  state: ProjectRecord;
}
/** Последовательность и идентификатор файла проверяются до восстановления координатора. */
export function validateProjectEvent(
  value: unknown,
  seq: number,
  projectId: string,
): ProjectJournalEvent {
  const entry = z
    .object({
      schemaVersion: z.literal(1),
      seq: z.literal(seq),
      at: text,
      type: text,
      message: text,
      state: z.unknown(),
    })
    .strict()
    .parse(value);
  const state = validateProject(entry.state);
  if (state.id !== projectId || state.revision !== seq) throw new Error('PROJECT_INVALID_SEQUENCE');
  return { ...entry, state };
}
