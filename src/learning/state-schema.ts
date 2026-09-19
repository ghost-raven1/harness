import { z } from 'zod';
import type { LearningState } from './types.js';

const text = z.string();
export const evidenceSchema = z
  .object({
    id: text,
    runId: text,
    agentId: text,
    role: text,
    kind: z.enum(['tool', 'feedback']),
    content: text,
    verified: z.boolean(),
  })
  .passthrough();
export const candidateSchema = z
  .object({
    id: text,
    sourceRunId: text,
    workspace: text,
    role: text,
    profile: text,
    title: text,
    lesson: text,
    appliesWhen: text,
    evidenceIds: z.array(text),
    status: z.enum(['candidate', 'evaluating', 'published', 'rejected', 'revoked']),
    reason: text.optional(),
    fingerprint: text,
  })
  .passthrough();
export const reportSchema = z
  .object({
    candidateId: text,
    baselineVersion: text,
    suiteHash: text,
    results: z.array(
      z.object({
        caseId: text,
        variant: z.enum(['baseline', 'candidate']),
        repetition: z.number().int().nonnegative(),
        passed: z.boolean(),
        detail: text,
      }),
    ),
    passed: z.boolean().optional(),
    reason: text.optional(),
  })
  .passthrough();
export const releaseSchema = z
  .object({
    id: text,
    parentId: text.optional(),
    createdAt: text,
    candidateIds: z.array(text),
    revoked: z.boolean().optional(),
    reason: text.optional(),
  })
  .passthrough();
export const learningStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeVersion: text,
    paused: z.boolean(),
    candidates: z.record(candidateSchema),
    evidence: z.record(evidenceSchema),
    reports: z.record(reportSchema),
    releases: z.record(releaseSchema),
    jobs: z.array(
      z.object({
        id: text,
        runId: text,
        role: text,
        candidateId: text.optional(),
        feedbackId: text.optional(),
        status: z.enum(['queued', 'done', 'inactive']),
        error: text.optional(),
        retryAt: text.optional(),
      }),
    ),
    daily: z.object({ date: text, tokens: z.number().nonnegative() }),
    ignoredRunIds: z.array(text).optional(),
  })
  .passthrough();

/** Проверяет сохранённый опыт без переписывания авторских данных и исторических полей. */
export function validateLearningState(value: unknown): LearningState {
  learningStateSchema.parse(value);
  const state = value as LearningState;
  const fail = (): never => {
    throw new Error('LEARNING_INVALID_REFERENCE');
  };
  if (!state.releases[state.activeVersion]) fail();
  for (const [key, item] of Object.entries(state.candidates))
    if (key !== item.id || item.evidenceIds.some((id) => !state.evidence[id])) fail();
  for (const [key, item] of Object.entries(state.evidence)) if (key !== item.id) fail();
  for (const [key, item] of Object.entries(state.releases)) {
    if (key !== item.id || item.candidateIds.some((id) => !state.candidates[id])) fail();
    if (item.parentId && !state.releases[item.parentId]) fail();
  }
  for (const item of Object.values(state.reports))
    if (!state.candidates[item.candidateId] || !state.releases[item.baselineVersion]) fail();
  return state;
}
