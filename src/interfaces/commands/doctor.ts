import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import type { CliContext } from '../types.js';
import { diagnose } from '../diagnostics.js';
import { note } from '../ui.js';
import { acquireLock } from '../ipc.js';
import { FileSessionStore } from '../../sessions/store.js';
import { verifyHistory } from '../../diagnostics/history-verification.js';
import {
  historyVerificationSchema,
  indexRebuildSchema,
  type HistoryVerificationReport,
  type IndexRebuildReport,
} from '../../diagnostics/history-types.js';
import { diagnosticExport, writeDiagnosticExport } from '../../diagnostics/export.js';
import { message } from '../../shared/primitives.js';

interface DoctorOptions {
  config?: string;
  verifyHistory?: boolean;
  rebuildIndex?: boolean;
  export?: string;
}

/** Передаёт обслуживание владельцу; без сервиса сама удерживает блокировку каталога состояния. */
async function historyAction(
  context: CliContext,
  rebuild: boolean,
): Promise<HistoryVerificationReport | IndexRebuildReport> {
  try {
    return await context.request(
      rebuild ? 'diagnostics.rebuildIndex' : 'diagnostics.verifyHistory',
      {},
    );
  } catch (error) {
    // Ошибка проверки сервиса не даёт права запускать второе обслуживание тех же файлов.
    if (!message(error).startsWith('Local service unavailable.')) throw error;
  }
  const release = await acquireLock(context.directory());
  try {
    if (!rebuild) return await verifyHistory(context.directory());
    const sessions = new FileSessionStore(context.directory());
    await sessions.initialize({ recover: false });
    return await sessions.rebuildIndex();
  } finally {
    await release();
  }
}

/** Печатает результаты локальной проверки и возвращает код ошибки при неготовом сервисе. */
export async function showDiagnostics(
  context: CliContext,
  file?: string,
  options: DoctorOptions = {},
): Promise<void> {
  const environment = await diagnose(context.directory(), file);
  const indexes = options.rebuildIndex
    ? indexRebuildSchema.parse(await historyAction(context, true))
    : undefined;
  const history =
    options.verifyHistory || options.export
      ? historyVerificationSchema.parse(await historyAction(context, false))
      : undefined;
  const report = {
    ...environment,
    ...(history ? { history } : {}),
    ...(indexes ? { indexes } : {}),
  };
  if (options.export) {
    const service = await context.request('system.info').catch(() => undefined);
    await writeDiagnosticExport(
      options.export,
      diagnosticExport(report.checks, { service, history, indexes }),
    );
  }
  if (context.json() || !process.stdout.isTTY) context.output(report);
  else {
    note(
      report.platform + ' · ' + report.arch + '\n' + report.transport + '\n' + report.endpoint,
      'Среда',
    );
    for (const check of report.checks) {
      const content = check.name + ': ' + check.detail + (check.hint ? '\n' + check.hint : '');
      if (check.status === 'pass') prompts.log.success(content);
      else if (check.status === 'warn') prompts.log.warn(content);
      else prompts.log.error(content);
    }
    if (indexes) {
      const summary = `Перестроено индексов: ${indexes.rebuilt}. Пропущено: ${indexes.skipped}.`;
      if (indexes.issues.length) prompts.log.error(summary);
      else prompts.log.success(summary);
      for (const issue of indexes.issues) prompts.log.error(issue.code);
    }
    if (history) {
      const summary = `История: задач ${history.counts.runs}, записей ${history.counts.records}.`;
      if (history.healthy) prompts.log.success(summary);
      else prompts.log.error(summary + ' Обнаружено повреждение. Выполнение задач недоступно.');
      for (const issue of history.issues)
        prompts.log.error(
          issue.code +
            (issue.runId ? ` · задача ${issue.runId}` : '') +
            (issue.record ? ` · запись ${issue.record}` : ''),
        );
      if (history.counts.unresolvedOperations)
        prompts.log.warn(
          `Нужна проверка результата операций: ${history.counts.unresolvedOperations}. Откройте соответствующие задачи перед продолжением.`,
        );
    }
    if (options.export) prompts.log.success('Отчёт сохранён: ' + options.export);
    prompts.outro(
      'Ключи проверены по наличию. Доступность модели проверяется при выполнении задачи.',
    );
  }
  const maintenance = options.verifyHistory || options.rebuildIndex || options.export;
  if (
    (maintenance ? report.checks.some((check) => check.status === 'fail') : !report.ready) ||
    (history && !history.healthy) ||
    indexes?.issues.length
  )
    process.exitCode = 1;
}

/** Подключает диагностику с необязательным явным манифестом конфигурации. */
export function registerDoctorCommand(program: Command, context: CliContext): void {
  program
    .command('doctor')
    .description('Проверить среду и конфиги, даже если сервис не запущен')
    .option('--config <file>', 'проверить конкретную конфигурацию')
    .option('--verify-history', 'проверить журналы без исправления данных')
    .option('--rebuild-index', 'перестроить производные индексы под блокировкой владельца')
    .option('--export <file>', 'сохранить обезличенный отчёт с проверкой истории в новый файл')
    .action((options: DoctorOptions) => showDiagnostics(context, options.config, options));
}
