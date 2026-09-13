export interface LearningEvidence {
  id: string;
  runId: string;
  agentId: string;
  role: string;
  kind: 'tool' | 'feedback';
  content: string;
  verified: boolean;
}
export interface LearningCandidate {
  id: string;
  sourceRunId: string;
  workspace: string;
  role: string;
  profile: string;
  title: string;
  lesson: string;
  appliesWhen: string;
  evidenceIds: string[];
  status: 'candidate' | 'evaluating' | 'published' | 'rejected' | 'revoked';
  reason?: string;
  fingerprint: string;
}
export interface EvaluationResult {
  caseId: string;
  variant: 'baseline' | 'candidate';
  repetition: number;
  passed: boolean;
  detail: string;
}
export interface EvaluationReport {
  candidateId: string;
  baselineVersion: string;
  suiteHash: string;
  results: EvaluationResult[];
  passed?: boolean;
  reason?: string;
}
export interface LearningRelease {
  id: string;
  parentId?: string;
  createdAt: string;
  candidateIds: string[];
  revoked?: boolean;
  reason?: string;
}
export interface LearningJob {
  id: string;
  runId: string;
  role: string;
  candidateId?: string;
  feedbackId?: string;
  status: 'queued' | 'done' | 'inactive';
  error?: string;
  retryAt?: string;
}
export interface LearningState {
  schemaVersion: 1;
  activeVersion: string;
  paused: boolean;
  candidates: Record<string, LearningCandidate>;
  evidence: Record<string, LearningEvidence>;
  reports: Record<string, EvaluationReport>;
  releases: Record<string, LearningRelease>;
  jobs: LearningJob[];
  daily: { date: string; tokens: number };
  ignoredRunIds?: string[];
}
/** Хранит проверяемые уроки, очередь и неизменяемое содержимое выпусков. */
export interface LearningStore {
  read(): LearningState;
  update(change: (state: LearningState) => void): Promise<void>;
  lessons(version: string, workspace: string, role: string, profile: string): string[];
}
/** Сравнивает версии на доверенных случаях и возвращает проверяемый отчёт. */
export interface LearningEvaluator {
  evaluate(candidate: LearningCandidate): Promise<EvaluationReport>;
}
