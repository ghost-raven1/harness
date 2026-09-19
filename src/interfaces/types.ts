import type {
  LearningState,
  LearningCandidate,
  LearningEvidence,
  EvaluationReport,
  LearningRelease,
} from '../learning/types.js';
import type { Approval, AgentStatus, RunStatus, RunRecord } from '../sessions/types.js';

export interface ServiceInfo {
  configFile?: string;
  node: string;
  version: string;
  state: string;
  buildId?: string | null;
  protocolVersion?: number;
  storageVersion?: number;
  capabilities?: string[];
  workspaces: string[];
  defaultProfile: string;
  tools: string[];
  activeRuns?: number;
  activeProjects?: number;
  projectCount?: number;
  recoveryError?: string;
  pendingApprovals?: number;
  learningVersion?: string;
  knowledgeCount?: number;
  profiles: Array<{
    id: string;
    provider: string;
    model: string;
    configured: boolean;
    baseUrl: string;
  }>;
}

export interface StatusView {
  project?: import('../sessions/project-run.js').ProjectRunLink;
  runId: string;
  task?: string;
  createdAt?: string;
  deletedAt?: string;
  sessionId: string;
  workspace: string;
  status: RunStatus;
  recoveryRequired?: boolean;
  pendingMessages?: number;
  profile: string;
  turns: number;
  iterations?: import('../runtime/iterations.js').IterationStatus['run'];
  learningVersion: string;
  result?: string;
  resultTruncated?: boolean;
  resultLength?: number;
  resultPage?: import('./result-pages.js').ResultPage;
  error?: string;
  pauseReason?: RunRecord['pauseReason'];
  providerPause?: RunRecord['providerPause'];
  cursor: number;
  usage: { input: number; output: number };
  budget?: import('./contracts/index.js').CommandResponse<'budget.status'>;
  agents: Array<{ id: string; role: string; status: AgentStatus }>;
  approvals: Approval[];
  events: Array<{
    seq: number;
    at?: string;
    type: string;
    payload: unknown;
    role?: string;
    title?: string;
    detail?: string;
    preview?: { text: string; reasoning?: string };
  }>;
  hasMoreEvents?: boolean;
  fileChanges?: Array<Omit<import('../tools/file-changes.js').FileChange, 'canonical'>>;
  unknownInvocations: Array<{ id: string; tool: string; arguments?: string }>;
}
/** Дополнительный поток доступен локальному интерфейсу, не расширяя инструменты MCP. */
export interface TaskView extends StatusView {
  output: {
    events: import('../sessions/output.js').OutputEvent[];
    cursor: number;
    hasMore: boolean;
  };
}

export interface RunSummary {
  runId: string;
  task: string;
  taskTruncated?: boolean;
  status: RunStatus;
  deletedAt?: string;
}

export interface RunOptions {
  stdin?: boolean;
  workspace?: string;
  profile?: string;
  session?: string;
  key?: string;
  detach?: boolean;
}

/** Общие параметры CLI; команды не зависят от устройства парсера глобальных флагов. */
export interface CliContext {
  directory(): string;
  json(): boolean;
  interactive(): boolean;
  output(value: unknown): void;
  request: import('./contracts/index.js').CommandRequest;
}

export interface LearningStatusView {
  activeVersion: string;
  activeCandidateIds?: string[];
  releases?: LearningRelease[];
  evaluationReady?: boolean;
  controlCases?: number;
  enabled: boolean;
  paused: boolean;
  dailyLimit: null;
  daily: LearningState['daily'];
  jobs: LearningState['jobs'];
  candidates: Array<
    Pick<LearningCandidate, 'id' | 'title' | 'status' | 'reason'> &
      Partial<Pick<LearningCandidate, 'workspace' | 'role' | 'profile'>>
  >;
}

/** Полный урок и проверяемые источники доступны только локальному интерфейсу человека. */
export interface LearningInspectView {
  candidate: LearningCandidate;
  evidence: Array<LearningEvidence | undefined>;
  report?: EvaluationReport;
}
