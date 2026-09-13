import type { LearningEvidence, LearningState } from './types.js';

/** Опровержение остаётся контекстом для модели, но не подтверждает успешный результат. */
export function isNegativeFeedback(evidence: LearningEvidence): boolean {
  if (evidence.kind !== 'feedback') return false;
  try {
    return (JSON.parse(evidence.content) as { positive?: unknown }).positive === false;
  } catch {
    return false;
  }
}

/** Отзывает уроки и ожидающие проверки; начатые запуски сохраняют содержимое своей версии. */
export function revokeCandidates(
  state: LearningState,
  candidateIds: Set<string>,
  reason: string,
): void {
  for (const candidateId of candidateIds) {
    const candidate = state.candidates[candidateId]!;
    candidate.status = 'revoked';
    candidate.reason = reason;
  }
  for (const job of state.jobs)
    if (job.status === 'queued' && candidateIds.has(job.candidateId ?? '')) {
      job.status = 'inactive';
      job.error = reason;
      delete job.retryAt;
    }
  while (state.releases[state.activeVersion]!.candidateIds.some((id) => candidateIds.has(id))) {
    const release = state.releases[state.activeVersion]!;
    release.revoked = true;
    release.reason = reason;
    state.activeVersion = release.parentId ?? 'baseline';
  }
}

/** Старое подтверждение человека нельзя использовать после его опровержения в той же задаче. */
export function withdrawConfirmations(
  state: LearningState,
  runId: string,
  role: string,
  reason: string,
): Set<string> {
  const withdrawn = new Set<string>();
  for (const evidence of Object.values(state.evidence))
    if (
      evidence.runId === runId &&
      evidence.role === role &&
      evidence.kind === 'feedback' &&
      evidence.verified
    ) {
      evidence.verified = false;
      withdrawn.add(evidence.id);
    }
  for (const job of state.jobs)
    if (job.status === 'queued' && withdrawn.has(job.feedbackId ?? '')) {
      job.status = 'inactive';
      job.error = reason;
      delete job.retryAt;
    }
  return new Set(
    Object.values(state.candidates)
      .filter((candidate) => candidate.evidenceIds.some((id) => withdrawn.has(id)))
      .map((candidate) => candidate.id),
  );
}
