import type { Command } from 'commander';
import type { CliContext } from '../types.js';

/** Ключ задаётся явно, чтобы повтор из скрипта после обрыва связи не дублировал уточнение. */
export function registerMessageCommand(program: Command, context: CliContext): void {
  program
    .command('message <runId> <text>')
    .description('Передать уточнение активной задаче без её остановки')
    .requiredOption('--key <key>', 'уникальный ключ сообщения; при повторе используйте прежний')
    .action(async (runId: string, message: string, options: { key: string }) => {
      context.output(
        await context.request('runtime.message', { runId, message, requestKey: options.key }),
      );
    });
}
