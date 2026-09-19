import type { Command } from 'commander';
import type { CliContext } from '../types.js';
import type { DataResetScope } from '../../application/data-reset.js';
import { resetData } from '../guided/reset-data.js';
import { showDiagnostics } from '../guided/diagnostics.js';

/** Общая очистка требует явного состава и подтверждения актуального предпросмотра. */
export function registerMaintenanceCommands(program: Command, context: CliContext): void {
  program
    .command('iterations')
    .description('Предел шагов до паузы: просмотр или изменение')
    .option('--run <runId>', 'настройка отдельной задачи на паузе')
    .option('--limit <number>', 'число шагов в одной порции, общее для всех подагентов')
    .action(async (options: { run?: string; limit?: string }) => {
      const params = options.run ? { runId: options.run } : {};
      const status = await context.request('iterations.status', params);
      if (options.limit === undefined) {
        context.output(status);
        return;
      }
      const limit = Number(options.limit);
      if (!/^\d+$/.test(options.limit) || !Number.isSafeInteger(limit) || limit < 1)
        throw new Error('Укажите положительное целое число шагов.');
      context.output(
        await context.request('iterations.configure', {
          ...params,
          limit,
          expectedLimit: status.run?.limit ?? status.defaultLimit,
        }),
      );
    });
  program
    .command('logs [action]')
    .description('Диагностический файл: status, on — включить, off — выключить')
    .action(async (action?: string) => {
      if (!action && context.interactive()) {
        await showDiagnostics(context);
        return;
      }
      if (action === undefined || action === 'status') {
        context.output(await context.request('diagnostics.status'));
        return;
      }
      if (!['on', 'off'].includes(action)) throw new Error('Выберите logs status, on или off.');
      context.output(await context.request('diagnostics.configure', { enabled: action === 'on' }));
    });
  program
    .command('reset')
    .description('Выбрать и очистить задачи, историю или накопленные знания')
    .option('--scope <scope>', 'tasks — задачи; learning — знания; all — оба раздела')
    .option('--preview', 'показать состав очистки и токен подтверждения')
    .option('--confirm <token>', 'подтвердить состав из --preview')
    .action(async (options: { scope?: DataResetScope; preview?: boolean; confirm?: string }) => {
      if (options.scope && !['tasks', 'learning', 'all'].includes(options.scope))
        throw new Error('Выберите состав: --scope tasks, learning или all.');
      if (options.preview && options.confirm)
        throw new Error('Выберите --preview или --confirm, а не оба сразу.');
      if ((options.preview || options.confirm) && !options.scope)
        throw new Error('Укажите состав очистки через --scope tasks, learning или all.');
      if (options.preview && options.scope) {
        context.output(await context.request('maintenance.resetPreview', { scope: options.scope }));
        return;
      }
      if (options.confirm && options.scope) {
        context.output(
          await context.request('maintenance.reset', {
            scope: options.scope,
            previewToken: options.confirm,
          }),
        );
        return;
      }
      if (!context.interactive())
        throw new Error(
          'Сначала запросите reset --scope <состав> --preview; затем передайте полученный токен через --confirm.',
        );
      await resetData(context, options.scope);
    });
}
