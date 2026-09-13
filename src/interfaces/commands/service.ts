import { assertRuntime } from '../../configuration/runtime-version.js';
import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { configFile } from '../../configuration/discovery.js';
import { serve } from '../ipc.js';
import { runMcp } from '../mcp-server.js';
import { note } from '../ui.js';
import { message } from '../../shared/primitives.js';
import type { CliContext } from '../types.js';

/** Удерживает сервис до сигнала остановки и дожидается корректного закрытия. */
async function runService(context: CliContext, config: string | undefined): Promise<void> {
  assertRuntime();
  const service = await serve(configFile(config), context.directory());
  if (process.stdout.isTTY && !context.json()) {
    prompts.log.success('Сервис готов · Node ' + process.version);
    note(
      'Состояние: ' +
        context.directory() +
        '\nКоманды: harness run · harness approvals · harness learning status',
      'Рабочая среда',
    );
  } else {
    context.output({ ready: true, state: context.directory(), node: process.version });
  }

  await new Promise<void>((resolveStopped) => {
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      try {
        await service.close();
      } catch (error) {
        process.stderr.write(message(error) + '\n');
        process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        resolveStopped();
      }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/** Подключает запуск сервиса, протокольный адаптер и диагностику. */
export function registerServiceCommands(program: Command, context: CliContext): void {
  program
    .command('serve')
    .description('Запустить локальный сервис')
    .option('--config <file>', 'главный конфиг; по умолчанию ищется в проекте')
    .action((options: { config?: string }) => runService(context, options.config));
  program
    .command('mcp')
    .description('Запустить stdio-адаптер для OpenCode')
    .action(() => runMcp(context.directory()));
}
