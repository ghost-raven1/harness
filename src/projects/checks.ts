import { hash, id } from '../shared/primitives.js';
import type { ToolCall } from '../providers/types.js';
import type { RunRecord } from '../sessions/types.js';
import type { ProjectIntent, ProjectReport, ProjectSnapshot } from './types.js';

/** Идентификаторы принятых проверок устойчивы при паузе и восстановлении одной попытки. */
export function checkCalls(intent: ProjectIntent): ToolCall[] {
  return (intent.checks ?? []).map((check, index) => ({
    id: 'check-' + index + '-' + hash({ command: check.command, args: check.args }).slice(0, 12),
    name: 'process.exec',
    arguments: JSON.stringify({ command: check.command, args: check.args }),
  }));
}

/** Отчёт строится по журналу исполнителя, а не по заявлению модели об успехе. */
export function checkReport(
  intent: ProjectIntent,
  run: RunRecord,
  after: ProjectSnapshot,
): ProjectReport {
  const calls = checkCalls(intent);
  const checks = (intent.checks ?? []).map((check, index) => {
    const invocation = Object.values(run.invocations).find(
      (item) => item.call.id === calls[index]!.id,
    );
    const artifact = run.artifacts.find((item) => item.callId === calls[index]!.id);
    return {
      ...check,
      status: invocation?.status ?? 'not_run',
      invocationId: invocation?.id,
      exitCode: invocation?.exitCode,
      artifactId: artifact?.id,
      summary: invocation?.result?.slice(0, 1500),
    };
  });
  const changed = intent.before?.digest !== after.digest;
  const unknown = checks.some((check) => check.status === 'unknown' || check.status === 'started');
  const passed =
    !changed &&
    run.status === 'completed' &&
    checks.every((check) => check.status === 'succeeded' && check.exitCode === 0);
  return {
    id: id(),
    phase: intent.phase!,
    stageId: intent.stageId,
    attempt: intent.attempt,
    runId: run.id,
    at: new Date().toISOString(),
    status: unknown ? 'unknown' : passed ? 'passed' : 'failed',
    workspaceRevision: after.digest,
    checks,
    ...(changed
      ? {
          note: 'Исходные файлы изменились во время проверок. Результат требует повторной проверки.',
        }
      : {}),
  };
}

/** Короткая обратная связь направляет исправление, сохраняя принятые критерии неизменными. */
export function correctionMessage(report: ProjectReport): string {
  return [
    'Обязательная проверка не прошла. Исправь реализацию, сохрани принятые критерии и команды.',
    report.note ?? '',
    ...report.checks.map(
      (check) =>
        check.title +
        ': ' +
        check.status +
        '; код ' +
        String(check.exitCode ?? 'не получен') +
        '\n' +
        (check.summary ?? 'Не запускалась.'),
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}
