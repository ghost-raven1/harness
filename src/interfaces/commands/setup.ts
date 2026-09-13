import { clientConfiguration } from '../mcp-config.js';
import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { CliContext } from '../types.js';
import type { Profile } from '../../configuration/schema.js';
import { defaultProfiles, initializeProject } from '../../configuration/initialize.js';
import { selected, note } from '../ui.js';
import { commandPage } from '../guided/screen.js';

interface Options {
  workspace?: string;
  provider?: Profile['provider'];
  model?: string;
  baseUrl?: string;
  keyEnv?: string;
  apiKey: boolean;
}

export async function initialize(
  context: CliContext,
  directory: string | undefined,
  options: Options,
): Promise<void> {
  const profiles = await defaultProfiles();
  if (!options.provider && context.interactive()) {
    commandPage('Создание конфигурации · модель');
    options.provider = selected(
      await prompts.select({
        message: 'Провайдер модели',
        options: Object.keys(profiles).map((value) => ({
          value: value as Profile['provider'],
          label: value,
        })),
      }),
    );
  }
  const provider = options.provider ?? 'qwen';
  const defaults = profiles[provider];
  if (!defaults) throw new Error('Unknown provider: ' + provider);
  if (provider === 'codex') {
    options.apiKey = false;
    options.baseUrl = defaults.baseUrl;
  }
  if (context.interactive()) {
    if (!options.workspace) {
      commandPage('Создание конфигурации · папка');
      options.workspace = selected(
        await prompts.text({ message: 'Рабочая папка проекта', initialValue: process.cwd() }),
      );
    }
    if (!options.model) {
      commandPage('Создание конфигурации · название модели');
      options.model = selected(
        await prompts.text({
          message: 'ID модели из вашего аккаунта или локального сервера',
          initialValue: defaults.model,
          validate: (value) => (value.trim() ? undefined : 'Введите ID модели'),
        }),
      );
    }
    if (!options.baseUrl) {
      commandPage('Создание конфигурации · адрес API');
      options.baseUrl = selected(
        await prompts.text({ message: 'Адрес API', initialValue: defaults.baseUrl }),
      );
    }
    if (options.apiKey && !options.keyEnv) {
      commandPage('Создание конфигурации · доступ');
      options.apiKey = selected(
        await prompts.confirm({
          message: 'Этот API требует ключ?',
          initialValue: !!defaults.apiKeyEnv,
          active: 'Да',
          inactive: 'Нет',
        }),
      );
    }
    if (options.apiKey && !options.keyEnv) {
      commandPage('Создание конфигурации · переменная ключа');
      options.keyEnv = selected(
        await prompts.text({
          message: 'Имя переменной окружения с ключом (сам ключ здесь не нужен)',
          initialValue: defaults.apiKeyEnv ?? 'MODEL_API_KEY',
          validate: (value) =>
            /^[a-z_][a-z0-9_]*$/i.test(value)
              ? undefined
              : 'Нужно имя переменной, например MODEL_API_KEY',
        }),
      );
    }
  }
  const workspace = resolve(options.workspace ?? process.cwd());
  const path = await initializeProject({
    directory: directory ? resolve(directory) : join(workspace, '.harness', 'config'),
    workspace,
    provider,
    model: options.model ?? defaults.model,
    baseUrl: options.baseUrl ?? defaults.baseUrl,
    apiKeyEnv: options.apiKey ? (options.keyEnv ?? defaults.apiKeyEnv) : undefined,
  });
  if (!context.interactive()) {
    context.output({ config: path, workspace, state: context.directory() });
    return;
  }
  commandPage('Конфигурация создана');
  note(
    [
      'Конфигурация: ' + path,
      options.apiKey && (options.keyEnv ?? defaults.apiKeyEnv)
        ? '1. Задайте переменную ' + (options.keyEnv ?? defaults.apiKeyEnv) + ' с ключом у сервиса.'
        : '1. Убедитесь, что локальный API запущен.',
      '2. В этой папке: harness serve',
      '3. Во втором терминале: harness',
      '4. Для OpenCode: harness mcp-config',
      'Во всех командах используйте тот же --state: ' + context.directory(),
    ].join('\n'),
    'Проект подготовлен',
  );
}

/** Первичная настройка и переносимый фрагмент подключения не меняют конфиги OpenCode пользователя. */
export function registerSetupCommands(program: Command, context: CliContext): void {
  program
    .command('init [directory]')
    .description('Создать конфигурацию для проекта')
    .option('--workspace <path>', 'рабочая папка')
    .option('--provider <id>', 'qwen, openai, anthropic, google, openai-compatible, codex')
    .option('--model <id>', 'ID модели')
    .option('--base-url <url>', 'адрес API')
    .option('--key-env <name>', 'имя переменной с ключом')
    .option('--no-api-key', 'локальный API без авторизации')
    .action((directory: string | undefined, options: Options) =>
      initialize(context, directory, options),
    );

  program
    .command('mcp-config')
    .description('Показать конфигурацию MCP для OpenCode или Codex')
    .option('--client <name>', 'opencode или codex', 'opencode')
    .action((options: { client: string }) => {
      process.stdout.write(
        clientConfiguration(
          options.client,
          process.execPath,
          fileURLToPath(new URL('../cli.js', import.meta.url)),
          context.directory(),
        ),
      );
    });
}
