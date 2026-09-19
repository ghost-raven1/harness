import type { ProjectChangeSet } from './change-types.js';
import type { ProjectCaptureSettings } from '../configuration/project-capture.js';
import type { z } from 'zod';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type {
  projectInputs,
  projectPlanSchema,
  projectReportSchema,
  projectStageSchema,
  projectViewSchema,
  projectSummarySchema,
  projectEventSchema,
  versionedPlanSchema,
} from './schema.js';

export type ProjectPlan = z.output<typeof projectPlanSchema>;
export type ProjectStage = z.output<typeof projectStageSchema>;
export type VersionedPlan = z.output<typeof versionedPlanSchema>;
export type ProjectReport = z.output<typeof projectReportSchema>;
export type ProjectView = z.output<typeof projectViewSchema>;
export type ProjectSummary = z.output<typeof projectSummarySchema>;
export type ProjectEvent = z.output<typeof projectEventSchema>;
export type ProjectInput<K extends keyof typeof projectInputs> = z.input<(typeof projectInputs)[K]>;
export interface ProjectSnapshot {
  contentRef?: string;
  digest: string;
  ref: string;
  files: number;
  createdAt: string;
}
export interface ProjectStageState {
  stageId: string;
  status: 'pending' | 'running' | 'checking' | 'manual' | 'completed' | 'blocked';
  attempt: number;
  runId?: string;
  sessionId?: string;
  summary?: string;
  manualRevision?: string;
  definitionHash: string;
}
export interface ProjectIntent {
  kind: 'planning' | 'stage' | 'checks';
  phase?: 'baseline' | 'stage' | 'final';
  stageId?: string;
  attempt: number;
  requestKey: string;
  message: string;
  runId?: string;
  sessionId?: string;
  expectedParentRunId?: string;
  before?: ProjectSnapshot;
  changeSetId?: string;
  checks?: z.output<typeof import('./schema.js').projectCheckSchema>[];
}
/** Исходный журнал проекта хранит решения; полные переписки остаются в связанных задачах. */
export interface ProjectRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  requestKey: string;
  requestHash: string;
  title: string;
  goal: string;
  workspace: string;
  profile: string;
  status: ProjectSummary['status'];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  config: ConfigSnapshot;
  learningVersion: string;
  capture?: ProjectCaptureSettings;
  changeSets?: ProjectChangeSet[];
  plan?: VersionedPlan;
  acceptedVersion?: number;
  acceptedAt?: string;
  stages: Record<string, ProjectStageState>;
  runIds: string[];
  reports: ProjectReport[];
  intent?: ProjectIntent;
  baseline?: ProjectSnapshot;
  checkpoint?: ProjectSnapshot;
  resultSnapshot?: ProjectSnapshot;
  externalSnapshot?: ProjectSnapshot;
  phase: 'planning' | 'baseline' | 'stages' | 'final' | 'acceptance';
  baselinePassed?: boolean;
  reason?: string;
  reasonCode?: string;
  receipts: Record<string, string>;
  messages?: Array<{
    requestKey: string;
    runId: string;
    stageId: string;
    message: string;
    sent?: boolean;
    rejected?: string;
  }>;
  deletedAt?: string;
}
