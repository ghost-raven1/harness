#!/usr/bin/env node
import { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { rpc } from './ipc.js';
import { print } from './ui.js';
import { brandName, renderLogo, showLogo } from './branding.js';
import { registerRunCommands } from './commands/run.js';
import { registerServiceCommands } from './commands/service.js';
import { registerLearningCommands } from './commands/learning.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDashboard } from './commands/dashboard.js';
import { registerMaintenanceCommands } from './commands/maintenance.js';
import { message } from '../shared/primitives.js';
import type { CliContext } from './types.js';

interface GlobalOptions {
  state: string;
  json: boolean;
}

/** Собирает группы команд и единообразно применяет глобальные параметры вывода. */
export function createCli(): Command {
  const program = new Command()
    .name('harness')
    .version('0.1.0')
    .description(brandName + ' · агенты, инструменты и проверяемое обучение')
    .option(
      '--state <directory>',
      'каталог состояния',
      process.env.HARNESS_STATE_DIR ?? join(homedir(), '.harness'),
    )
    .option('--no-color', 'отключить цвета')
    .option('--json', 'машинный JSON вместо оформления', false)
    .showHelpAfterError();

  const directory = (): string => resolve(program.opts<GlobalOptions>().state);
  const json = (): boolean => program.opts<GlobalOptions>().json;
  const context: CliContext = {
    directory,
    json,
    interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY && !json(),
    output: (value) => print(value, json()),
    request: (method, params = {}) => rpc(directory(), method, params),
  };

  let logoShown = false;
  program.hook('preAction', (_root, command) => {
    if (
      !(command === program && context.interactive() && process.env.TERM !== 'dumb') &&
      !['mcp', 'mcp-config'].includes(command.name()) &&
      process.stdout.isTTY &&
      !json() &&
      !logoShown
    ) {
      showLogo();
      logoShown = true;
    }
  });
  program.addHelpText('beforeAll', () => {
    if (!process.stdout.isTTY || json() || logoShown) return '';
    logoShown = true;
    return renderLogo(process.stdout.columns || 80, process.env.TERM === 'dumb') + '\n';
  });

  registerSetupCommands(program, context);
  registerServiceCommands(program, context);
  registerDoctorCommand(program, context);
  registerRunCommands(program, context);
  registerLearningCommands(program, context);
  registerMaintenanceCommands(program, context);
  program
    .command('budget')
    .description('Учёт токенов задач и обучения за сегодня')
    .action(async () => context.output(await context.request('budget.status')));
  registerDashboard(program, context);
  return program;
}

// Node учитывает ссылки npm bin и отличает запуск CLI от импорта createCli.
if (import.meta.main) {
  createCli()
    .parseAsync()
    .catch((error: unknown) => {
      if (message(error) === 'INTERACTIVE_CANCEL') {
        process.exitCode = 130;
        return;
      }
      if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify({ error: message(error) }) + '\n');
      } else {
        prompts.log.error(message(error));
      }
      process.exitCode = 1;
    });
}
