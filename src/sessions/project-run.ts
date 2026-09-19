import { z } from 'zod';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { ToolCall } from '../providers/types.js';
import type { RunCatalogEntry } from './ports.js';
import type { RunRecord, RunStatus } from './types.js';

export const projectRunLinkSchema = z
  .object({
    projectId: z.string().min(1),
    planVersion: z.number().int().positive(),
    stageId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    kind: z.enum(['planning', 'stage', 'checks']),
  })
  .strict();
export type ProjectRunLink = z.infer<typeof projectRunLinkSchema>;

/** Закрепляет исходные инструкции и опыт; текущие настройки сервиса их не заменяют. */
export interface ProjectRunStart {
  link: ProjectRunLink;
  requestKey: string;
  workspace: string;
  profile: string;
  config: ConfigSnapshot;
  learningVersion: string;
  role: string;
  message: string;
  sessionId?: string;
  expectedParentRunId?: string;
  calls?: ToolCall[];
  dependencies?: Array<{ runId: string; title: string }>;
}

/** Уведомление является подсказкой: после сбоя состояние сверяется с журналом и каталогом. */
export interface RunSettled {
  runId: string;
  link: ProjectRunLink;
  status: RunStatus;
  seq: number;
  recoveryRequired: boolean;
}

/** Общая регистрация работы закрывает окно между проверкой папки и сохранением запуска. */
export interface WorkspaceAccess {
  reserve(input: { workspace: string; projectId?: string }): () => void;
  assertWrite(run: RunRecord): void;
}

/** Внутренний порт оркестратора; методы не становятся командами модели или публичного runtime. */
export interface ProjectRunPort {
  catalog(): RunCatalogEntry[];
  start(input: ProjectRunStart): Promise<{ runId: string; sessionId: string }>;
  inspect(runId: string): Promise<RunRecord>;
  find(requestKey: string): RunCatalogEntry | undefined;
  busy(runId: string): boolean;
  pause(runId: string): Promise<void>;
  resume(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  sendMessage(input: { runId: string; message: string; requestKey: string }): Promise<{
    runId: string;
    sessionId: string;
    messageId: string;
    status: 'queued' | 'delivered';
  }>;
  resolve(input: {
    runId: string;
    invocationId: string;
    result: string;
    succeeded: boolean;
  }): Promise<void>;
  subscribeSettled(listener: (event: RunSettled) => void): () => void;
}

/** Дополнительное ограничение режима применяется даже к скрытым вызовам модели. */
export function planningToolAllowed(name: string): boolean {
  return ['fs.read', 'fs.list', 'fs.search', 'artifacts.read'].includes(name);
}
