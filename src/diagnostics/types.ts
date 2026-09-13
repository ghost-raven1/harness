/** Диагностика хранит только технические признаки, без содержимого команд и ответов. */
export interface DiagnosticStatus {
  enabled: boolean;
  file: string;
  directory: string;
  maxBytes: number;
  retainedFiles: number;
  error?: string;
}

export const diagnosticMethods = [
  'runtime.run',
  'runtime.status',
  'runtime.task',
  'runtime.list',
  'runtime.history',
  'runtime.cancel',
  'runtime.resume',
  'runtime.resolve',
  'runtime.delete',
  'runtime.purgePreview',
  'runtime.purge',
  'drafts.list',
  'drafts.get',
  'drafts.create',
  'drafts.update',
  'drafts.remove',
  'drafts.rebase',
  'approvals.list',
  'approvals.decide',
  'budget.status',
  'iterations.status',
  'iterations.configure',
  'learning.status',
  'learning.inspect',
  'learning.export',
  'learning.feedback',
  'learning.rollback',
  'learning.pause',
  'learning.resume',
  'files.preview',
  'files.previewRestore',
  'files.restore',
  'system.info',
  'maintenance.resetPreview',
  'maintenance.reset',
  'diagnostics.status',
  'diagnostics.configure',
] as const;

export type DiagnosticMethod = (typeof diagnosticMethods)[number] | 'unknown';
export const diagnosticCodes = [
  'COMMAND_FAILED',
  'CANCELLED',
  'TIMEOUT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EROFS',
  'ENOENT',
] as const;
export type DiagnosticCode = (typeof diagnosticCodes)[number];
export type DiagnosticEvent =
  | { type: 'service.started' | 'service.stopped' }
  | { type: 'task.finished'; runId: string; status: 'completed' | 'failed' }
  | {
      type: 'command.succeeded' | 'command.failed';
      method: string;
      durationMs: number;
      code?: DiagnosticCode;
    };

/** Произвольное имя из RPC никогда не сохраняется в файл. */
export function diagnosticMethod(method: string): DiagnosticMethod {
  return (diagnosticMethods as readonly string[]).includes(method)
    ? (method as DiagnosticMethod)
    : 'unknown';
}
