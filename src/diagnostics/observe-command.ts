import type { FileDiagnosticLog } from './file-log.js';
import { diagnosticCodes, diagnosticMethod, type DiagnosticCode } from './types.js';

const frequentReads = new Set([
  'runtime.status',
  'runtime.task',
  'runtime.list',
  'runtime.history',
  'runtime.purgePreview',
  'drafts.list',
  'drafts.get',
  'approvals.list',
  'budget.status',
  'iterations.status',
  'learning.status',
  'learning.inspect',
  'files.preview',
  'files.previewRestore',
  'system.info',
  'maintenance.resetPreview',
  'diagnostics.status',
]);

function failureCode(error: unknown): DiagnosticCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && (diagnosticCodes as readonly string[]).includes(code)
    ? (code as DiagnosticCode)
    : 'COMMAND_FAILED';
}

/** Сохраняет только имя команды и исход; тела RPC и сообщения исключений остаются вне лога. */
export async function observeCommand<T>(
  log: FileDiagnosticLog,
  method: string,
  work: () => Promise<T>,
): Promise<T> {
  const name = diagnosticMethod(method);
  const start = performance.now();
  const duration = (): number =>
    Math.min(86400000, Math.max(0, Math.round(performance.now() - start)));
  try {
    const result = await work();
    if (!frequentReads.has(name))
      await log.record({ type: 'command.succeeded', method: name, durationMs: duration() });
    return result;
  } catch (error) {
    await log.record({
      type: 'command.failed',
      method: name,
      durationMs: duration(),
      code: failureCode(error),
    });
    throw error;
  }
}
