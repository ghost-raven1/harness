import { requireProjectDiffs } from './project-changes.js';
import { readFile } from 'node:fs/promises';
import { Command, Option } from 'commander';
import type { CliContext } from '../types.js';

/** Команды просмотра используют те же контракты и страницы, что интерактивные экраны. */
export function registerProjectReadCommands(
  projects: Command,
  context: CliContext,
  integer: (value: string) => number,
): void {
  projects
    .command('reports <projectId>')
    .description('Проверки и попытки с состоянием доказательств')
    .addOption(new Option('--phase <phase>', 'фаза').choices(['baseline', 'stage', 'final']))
    .option('--stage <stageId>', 'этап')
    .option('--attempt <number>', 'попытка', integer)
    .option('--offset <number>', 'смещение страницы', integer, 0)
    .action(
      async (
        projectId: string,
        options: {
          phase?: 'baseline' | 'stage' | 'final';
          stage?: string;
          attempt?: number;
          offset: number;
        },
      ) =>
        context.output(
          await context.request('projects.reports', {
            projectId,
            phase: options.phase,
            stageId: options.stage,
            attempt: options.attempt,
            offset: options.offset,
          }),
        ),
    );
  projects
    .command('check-output <projectId> <reportId> <checkId>')
    .description('Страница сохранённого stdout или stderr; размер до 16 384 символов')
    .addOption(
      new Option('--stream <stream>', 'поток').choices(['stdout', 'stderr']).default('stdout'),
    )
    .option('--offset <number>', 'смещение из nextOffset предыдущей страницы', integer, 0)
    .action(
      async (
        projectId: string,
        reportId: string,
        checkId: string,
        options: { stream: 'stdout' | 'stderr'; offset: number },
      ) =>
        context.output(
          await context.request('projects.checkOutput', {
            projectId,
            reportId,
            checkId,
            ...options,
          }),
        ),
    );
  projects
    .command('review <projectId>')
    .description('Итог и актуальность доказательств без создания снимка')
    .action(async (projectId: string) =>
      context.output(await context.request('projects.review', { projectId })),
    );
  projects
    .command('plan-versions <projectId>')
    .description('Сохранённые версии плана')
    .option('--offset <number>', 'смещение страницы', integer, 0)
    .action(async (projectId: string, options: { offset: number }) =>
      context.output(
        await context.request('projects.planVersions', { projectId, offset: options.offset }),
      ),
    );
  projects
    .command('compare-plans <projectId>')
    .description('Изменения между версиями по устойчивым идентификаторам')
    .option('--from <number>', 'исходная версия; по умолчанию последняя принятая', integer)
    .option('--to <number>', 'новая версия; по умолчанию текущая', integer)
    .action(async (projectId: string, options: { from?: number; to?: number }) =>
      context.output(
        await context.request('projects.comparePlans', {
          projectId,
          fromVersion: options.from,
          toVersion: options.to,
        }),
      ),
    );
  projects
    .command('validate-plan <projectId>')
    .description('Проверить черновик без модели, запуска команд и изменения проекта')
    .requiredOption('--file <file>', 'JSON-файл плана без version')
    .option('--revision <number>', 'ожидаемая ревизия проекта', integer)
    .action(async (projectId: string, options: { file: string; revision?: number }) =>
      context.output(
        await context.request('projects.validatePlan', {
          projectId,
          plan: JSON.parse(await readFile(options.file, 'utf8')) as unknown,
          expectedRevision: options.revision,
        }),
      ),
    );
  const exportOptions = (command: Command) =>
    command
      .requiredOption('--revision <number>', 'ревизия из projects show', integer)
      .addOption(
        new Option('--format <format>', 'формат отчёта')
          .choices(['markdown', 'json'])
          .default('markdown'),
      )
      .option(
        '--include-logs',
        'добавить сохранённые stdout/stderr; могут содержать данные команд',
        false,
      )
      .option('--include-diffs', 'добавить построчные изменения сохранённых текстов', false);
  exportOptions(
    projects
      .command('export-preview <projectId>')
      .description('Состав отчёта и токен подтверждения'),
  ).action(
    async (
      projectId: string,
      options: {
        revision: number;
        format: 'markdown' | 'json';
        includeLogs: boolean;
        includeDiffs: boolean;
      },
    ) => {
      if (options.includeDiffs) await requireProjectDiffs(context);
      context.output(
        await context.request('projects.exportPreview', {
          projectId,
          expectedRevision: options.revision,
          format: options.format,
          includeLogs: options.includeLogs,
          ...(options.includeDiffs ? { includeDiffs: true } : {}),
        }),
      );
    },
  );
  exportOptions(
    projects
      .command('export <projectId>')
      .description('Сохранить подтверждённый отчёт внутри состояния Harness'),
  )
    .requiredOption('--preview-token <token>', 'токен из export-preview')
    .requiredOption('--key <key>', 'ключ запроса; повтор с тем же ключом возвращает прежний файл')
    .action(
      async (
        projectId: string,
        options: {
          revision: number;
          format: 'markdown' | 'json';
          includeLogs: boolean;
          includeDiffs: boolean;
          previewToken: string;
          key: string;
        },
      ) => {
        if (options.includeDiffs) await requireProjectDiffs(context);
        context.output(
          await context.request('projects.exportReport', {
            projectId,
            expectedRevision: options.revision,
            format: options.format,
            includeLogs: options.includeLogs,
            previewToken: options.previewToken,
            requestKey: options.key,
            ...(options.includeDiffs ? { includeDiffs: true } : {}),
          }),
        );
      },
    );
}
