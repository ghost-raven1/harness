import type { LearningState } from './types.js';
import type { PurgeRecord } from '../sessions/purge-records.js';

/** Находит уроки и проверки, зависимые от удаляемых источников или выпусков опыта. */
export function learningPurgePlan(state: LearningState, runIds: string[]) {
  const runs = new Set(runIds);
  const evidenceIds = Object.values(state.evidence)
    .filter((item) => runs.has(item.runId))
    .map((item) => item.id);
  const evidence = new Set(evidenceIds);
  const candidates = new Set(
    Object.values(state.candidates)
      .filter(
        (item) => runs.has(item.sourceRunId) || item.evidenceIds.some((id) => evidence.has(id)),
      )
      .map((item) => item.id),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const report of Object.values(state.reports)) {
      const baseline = state.releases[report.baselineVersion];
      if (
        !candidates.has(report.candidateId) &&
        baseline?.candidateIds.some((id) => candidates.has(id))
      ) {
        candidates.add(report.candidateId);
        changed = true;
      }
    }
  }
  const candidateIds = [...candidates].sort();
  return {
    candidateIds,
    evidenceIds: evidenceIds.sort(),
    reportIds: Object.keys(state.reports)
      .filter((id) => candidates.has(id))
      .sort(),
    affectedVersions: Object.values(state.releases)
      .filter((release) => release.candidateIds.some((id) => candidates.has(id)))
      .map((release) => release.id)
      .sort(),
  };
}

/** Удаление применяется также к старому журналу, поэтому прежние тексты не остаются в снимках. */
export function eraseLearningSources(state: LearningState, record: PurgeRecord): void {
  const runs = new Set(record.runIds),
    candidates = new Set(record.candidateIds);
  const feedbackReasons = new Set<string>();
  for (const evidence of Object.values(state.evidence)) {
    if (!runs.has(evidence.runId)) continue;
    if (evidence.kind === 'feedback') {
      try {
        const feedback = JSON.parse(evidence.content) as { text?: unknown };
        if (typeof feedback.text === 'string') feedbackReasons.add(feedback.text);
      } catch {
        /* Некорректный старый отзыв удаляется вместе с источником. */
      }
    }
    delete state.evidence[evidence.id];
  }
  for (const evidenceId of record.evidenceIds) delete state.evidence[evidenceId];
  for (const candidateId of record.candidateIds) {
    delete state.candidates[candidateId];
    delete state.reports[candidateId];
  }
  for (const reportId of record.reportIds) delete state.reports[reportId];
  for (const candidate of Object.values(state.candidates))
    if (candidate.reason && feedbackReasons.has(candidate.reason)) delete candidate.reason;
  for (const release of Object.values(state.releases)) {
    release.candidateIds = release.candidateIds.filter((id) => !candidates.has(id));
    if (release.reason && feedbackReasons.has(release.reason)) delete release.reason;
  }
  state.jobs = state.jobs.filter(
    (job) => !runs.has(job.runId) && !candidates.has(job.candidateId ?? ''),
  );
}
