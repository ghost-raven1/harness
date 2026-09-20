import type { CoordinationPlan } from '../agents/planning.js';
import type { Profile } from '../configuration/schema.js';
import type { RunInsights, UsageTotals } from '../insights/schema.js';

export type BenchmarkMode = 'solo' | 'fixed' | 'auto';
export interface BenchmarkPart {
  title: string;
  role: 'executor' | 'researcher';
  reads: string[];
  writes: Record<string, string>;
}
export interface BenchmarkScenario {
  id: string;
  title: string;
  goal: string;
  files: Record<string, string>;
  parts: BenchmarkPart[];
  finalWrites: Record<string, string>;
  checks: Array<{ title: string; assertion: string }>;
  fixedPlan: CoordinationPlan;
}
export interface BenchmarkSelection {
  kind: 'offline' | 'profile';
  profileId: string;
  profile: Profile;
}
export interface BenchmarkTrial {
  index: number;
  scenario: string;
  mode: BenchmarkMode;
  repeat: number;
}
export interface BenchmarkResult extends BenchmarkTrial {
  status: 'passed' | 'failed' | 'cancelled';
  runId?: string;
  configHash?: string;
  wallMs: number;
  checks: Array<{ title: string; passed: boolean; error?: string }>;
  command: string;
  args: string[];
  verification?: {
    exitCode: number | null;
    artifact: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  error?: string;
  cleanupError?: string;
  insightsError?: string;
  insights?: RunInsights;
}
export interface BenchmarkReport {
  schemaVersion: 1;
  benchmarkVersion: 1;
  environment: {
    appVersion: string;
    buildId: string | null;
    node: string;
    platform: string;
    arch: string;
  };
  kind: BenchmarkSelection['kind'];
  profile: { id: string; provider: string; model: string; parameterHash: string };
  learningVersion: 'baseline';
  roles: string[];
  limits: {
    agents: number;
    depth: number;
    modelConcurrency: number;
    turns: number;
    trialTimeoutMs: number;
  };
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  planned: number;
  fixtures: Array<{ id: string; hash: string; checks: string[] }>;
  summary: Array<{
    scenario: string;
    mode: BenchmarkMode;
    finished: number;
    passed: number;
    failed: number;
    cancelled: number;
    meanWallMs: number | null;
    retries: number | null;
    usage: UsageTotals | null;
    completeness: RunInsights['completeness'];
  }>;
  results: BenchmarkResult[];
  error?: string;
}
