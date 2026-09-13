import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import type { CliContext } from '../types.js';
import { diagnose } from '../diagnostics.js';
import { note } from '../ui.js';

export async function showDiagnostics(context: CliContext, file?: string): Promise<void> {
  const report = await diagnose(context.directory(), file);
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
    prompts.outro(
      'Ключи проверены по наличию. Доступность модели проверяется при выполнении задачи.',
    );
  }
  if (!report.ready) process.exitCode = 1;
}

export function registerDoctorCommand(program: Command, context: CliContext): void {
  program
    .command('doctor')
    .description('Проверить среду и конфиги, даже если сервис не запущен')
    .option('--config <file>', 'проверить конкретную конфигурацию')
    .action((options: { config?: string }) => showDiagnostics(context, options.config));
}
