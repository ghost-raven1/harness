import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../configuration/loader.js';
import { benchmarkPreview } from '../../benchmark/report.js';
import { offlineSelection, runSpecialistBenchmark } from '../../benchmark/runner.js';
import type { BenchmarkSelection } from '../../benchmark/types.js';
import type { CliContext } from '../types.js';
import { liveConfirm } from '../guided/live-confirm.js';
import { terminalText } from '../guided/screen.js';

interface BenchmarkOptions {
  real?: boolean;
  config?: string;
  profile?: string;
  output?: string;
  confirmReal?: boolean;
}

/** Читает только выбранный профиль; подключения MCP и права пользовательской конфигурации не запускаются. */
async function selectionFor(options: BenchmarkOptions): Promise<BenchmarkSelection> {
  if (!options.real) {
    if (options.profile || options.config || options.confirmReal)
      throw new Error(
        'Для реального профиля укажите --real --config <файл> --profile <имя>. Без них работает офлайн-стенд.',
      );
    return offlineSelection();
  }
  if (!options.config || !options.profile)
    throw new Error('Реальному стенду нужны --config <файл> и --profile <имя>.');
  const config = await loadConfig(resolve(options.config));
  const profile = config.value.profiles[options.profile];
  if (!profile) throw new Error('Профиль отсутствует в конфигурации: ' + options.profile);
  if (profile.apiKeyEnv && !process.env[profile.apiKeyEnv])
    throw new Error('Ключ выбранного профиля не настроен.');
  return { kind: 'profile', profileId: options.profile, profile: structuredClone(profile) };
}

/** Сравнивает режимы в отдельном приложении, не подключаясь к обычному сервису пользователя. */
export function registerBenchmarkCommands(program: Command, context: CliContext): void {
  program
    .command('benchmark')
    .description('Изолированные сравнительные проверки')
    .command('specialists')
    .description('Пять сценариев × три режима × три повтора')
    .option('--real', 'использовать реальную модель вместо подготовленного провайдера')
    .option('--config <file>', 'конфигурация, содержащая выбранный профиль')
    .option('--profile <name>', 'профиль для всех запусков стенда')
    .option('--confirm-real', 'явно подтвердить 45 запусков реальной модели')
    .option('--output <directory>', 'новый каталог отчётов и изолированных запусков')
    .action(async (options: BenchmarkOptions) => {
      const selection = await selectionFor(options);
      const preview = benchmarkPreview(selection);
      const output = resolve(
        options.output ??
          'benchmark-specialists-' +
            new Date().toISOString().replaceAll(/[:.]/g, '-') +
            '-' +
            randomUUID().slice(0, 8),
      );
      if (selection.kind === 'profile' && !options.confirmReal) {
        if (!context.interactive()) {
          process.stderr.write(terminalText(preview) + '\n');
          throw new Error(
            'После просмотра параметров подтвердите реальную модель флагом --confirm-real.',
          );
        }
        const confirmed = await liveConfirm({
          title: 'Сравнение специалистов',
          message: 'Запустить 45 задач реальной модели?',
          body: preview + '\n\nОтчёты: ' + output,
          active: 'Начать',
          inactive: 'Отмена',
          load: async () => ({ available: true, detail: 'Изолированный стенд' }),
        });
        if (confirmed !== true) return;
      } else process.stderr.write(terminalText(preview) + '\n');
      const controller = new AbortController();
      const stop = () => controller.abort(new Error('Стенд остановлен пользователем.'));
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, stop);
      const spinner = !context.json() && context.interactive() ? prompts.spinner() : undefined;
      spinner?.start('Подготавливаю отдельные учебные запуски');
      let stopped = false;
      try {
        const result = await runSpecialistBenchmark({
          output,
          selection,
          confirmedReal: selection.kind === 'profile',
          signal: controller.signal,
          onProgress: (trial, completed) =>
            spinner?.message(
              `${completed}/45 · ${trial.scenario} · ${trial.mode} · повтор ${trial.repeat}`,
            ),
        });
        spinner?.stop(
          result.report.status === 'cancelled' ? 'Частичный отчёт сохранён' : 'Сравнение завершено',
        );
        stopped = true;
        context.output({
          directory: result.directory,
          status: result.report.status,
          completed: result.report.results.length,
          planned: result.report.planned,
          passed: result.report.results.filter((entry) => entry.status === 'passed').length,
        });
        if (controller.signal.aborted) process.exitCode = 130;
      } finally {
        if (!stopped) spinner?.stop();
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, stop);
      }
    });
}
