import type { ConfigSnapshot } from '../configuration/schema.js';
import type { ChatMessage, ToolCall } from '../providers/types.js';
export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export interface AgentState {
  id: string;
  parentId?: string;
  role: string;
  authorityRoles: string[];
  depth: number;
  task: string;
  status: AgentStatus;
  messages: ChatMessage[];
  summary: string;
  result?: string;
  error?: string;
  pending?: ToolCall[];
  completedCalls: string[];
  children: string[];
  collectedChildren: string[];
}
export interface ToolInvocation {
  id: string;
  agentId: string;
  role?: string;
  call: ToolCall;
  effect: 'read' | 'write' | 'control';
  status: 'started' | 'succeeded' | 'error' | 'denied' | 'cancelled' | 'unknown';
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface Approval {
  id: string;
  runId: string;
  agentId: string;
  callId: string;
  binding: string;
  previewToken?: string;
  tool: string;
  args: unknown;
  reason: string;
  status: 'pending' | 'allowed' | 'denied' | 'consumed' | 'cancelled';
}
export interface RunRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  requestKey: string;
  requestHash: string;
  parentRunId?: string;
  coordination?: import('../agents/planning.js').CoordinationState;
  workspace: string;
  profile: string;
  config: ConfigSnapshot;
  learningVersion: string;
  status: RunStatus;
  rootAgentId: string;
  userMessages?: RunUserMessage[];
  agents: Record<string, AgentState>;
  invocations: Record<string, ToolInvocation>;
  approvals: Record<string, Approval>;
  artifacts: Array<{ id: string; agentId: string; callId: string }>;
  fileChanges?: import('../tools/file-changes.js').FileChange[];
  turns: number;
  iterationLimit?: number;
  iterationStart?: number;
  pauseReason?: 'iterations' | 'provider';
  providerPause?: { kind: 'rate_limit' | 'quota'; retryAt?: string };
  handoffs: number;
  usage: { input: number; output: number };
  createdAt: string;
  deletedAt?: string;
  result?: string;
  error?: string;
}
/** Уточнение сохраняется отдельно до безопасного включения в историю корневого агента. */
export interface RunUserMessage {
  id: string;
  requestKey: string;
  content: string;
  receivedAt: string;
  deliveredAt?: string;
}
export interface JournalEvent {
  seq: number;
  at: string;
  type: string;
  payload: unknown;
  state: RunRecord;
}
/** Совместимый экспорт составного порта; контракты чтения и записи находятся рядом. */
export type { SessionStore } from './ports.js';
