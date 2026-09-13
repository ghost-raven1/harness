import { z } from 'zod';
import type { LearningCandidate, LearningState } from './types.js';

export const proposalSchema = z
  .object({
    title: z.string().min(1).max(200),
    lesson: z.string().min(1).max(3000),
    appliesWhen: z.string().min(1).max(500),
    evidenceIds: z.array(z.string()).min(1).max(20),
  })
  .strict();
/** Структурные и лексические проверки дополняют контрольные задачи, но не доказывают смысловую корректность. */
export function rejectReason(
  candidate: LearningCandidate,
  state: LearningState,
): string | undefined {
  if (
    candidate.evidenceIds.some(
      (id) =>
        !state.evidence[id]?.verified ||
        state.evidence[id]!.runId !== candidate.sourceRunId ||
        state.evidence[id]!.role !== candidate.role,
    )
  )
    return 'Evidence is missing, unverified or outside the candidate scope';
  if (
    /(ignore|override|bypass|disable).{0,50}(policy|permission|rule|instruction)|игнорир|обойти.{0,30}(запрет|правил)|отключ.{0,30}(провер|запрет)|api[_ -]?key|secret|authorization:|sk-[a-z0-9]{12}/i.test(
      candidate.lesson + ' ' + candidate.appliesWhen,
    )
  )
    return 'Lesson attempts to change authority or contains credential-like material';
  const active = state.releases[state.activeVersion]!.candidateIds.map(
    (id) => state.candidates[id]!,
  );
  if (
    active.some(
      (item) =>
        item.workspace === candidate.workspace &&
        item.role === candidate.role &&
        item.profile === candidate.profile &&
        item.appliesWhen.toLowerCase() === candidate.appliesWhen.toLowerCase() &&
        item.lesson !== candidate.lesson,
    )
  )
    return 'Conflicts with an active lesson in the same scope';
  return undefined;
}
