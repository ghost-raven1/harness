import { registerProjectChangeCommands, requireProjectDiffs } from './project-changes.js';
import { readFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from 'commander';
import { projectPlanSchema } from '../../projects/schema.js';
import type { CliContext } from '../types.js';
import { registerProjectReadCommands } from './project-reports.js';
import { registerProjectInsightsCommand } from './insights.js';

interface MutationOptions {
  revision: number;
  key: string;
}
/** Не допускает неявного округления или отрицательной ревизии из командной строки. */
function integer(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
    throw new InvalidArgumentError('Нужно целое неотрицательное число.');
  return number;
}
/** Повтор команды использует прежние ключ и ревизию, поэтому обрыв связи не дублирует действие. */
function mutation(command: Command): Command {
  return command
    .requiredOption('--revision <number>', 'ревизия из projects show', integer)
    .requiredOption('--key <key>', 'ключ запроса; при повторе используйте прежний');
}
/** Связывает показанную ревизию и ключ запроса с конкретным проектом. */
function reference(projectId: string, options: MutationOptions) {
  return { projectId, expectedRevision: options.revision, requestKey: options.key };
}

/** CLI предоставляет те же проверяемые операции, что и рабочий стол. */
export function registerProjectCommands(program: Command, context: CliContext): void {
  const projects = program
    .command('projects')
    .description('Проекты: цель, план, этапы и приёмка результата');
  registerProjectReadCommands(projects, context, integer);
  registerProjectChangeCommands(projects, context, integer);
  registerProjectInsightsCommand(projects, context, integer);
  projects
    .command('list')
    .description('Список проектов')
    .option('--query <text>', 'поиск', '')
    .option('--page <number>', 'страница, начиная с нуля', integer, 0)
    .option('--archived', 'включить архив', false)
    .option('--attention', 'только проекты, требующие решения', false)
    .action(
      async (options: { query: string; page: number; archived: boolean; attention: boolean }) =>
        context.output(
          await context.request('projects.list', {
            query: options.query,
            page: options.page,
            includeArchived: options.archived,
            ...(options.attention ? { attentionOnly: true } : {}),
          }),
        ),
    );
  projects
    .command('show <projectId>')
    .description('План, этапы, проверки и доступные действия')
    .option('--cursor <number>', 'курсор журнала', integer, 0)
    .action(async (projectId: string, options: { cursor: number }) =>
      context.output(
        await context.request('projects.detail', { projectId, cursor: options.cursor }),
      ),
    );
  projects
    .command('create <title> <goal>')
    .description('Сохранить цель; затем projects plan предложит план')
    .requiredOption('--workspace <directory>', 'рабочая папка')
    .option('--profile <name>', 'профиль модели')
    .requiredOption('--key <key>', 'ключ запроса; при повторе используйте прежний')
    .option('--capture <mode>', 'сохранять содержимое будущих снимков: on или off')
    .action(
      async (
        title: string,
        goal: string,
        options: { workspace: string; profile?: string; key: string; capture?: string },
      ) => {
        if (options.capture !== undefined) {
          if (options.capture !== 'on' && options.capture !== 'off')
            throw new Error('Укажите --capture on или --capture off.');
          await requireProjectDiffs(context);
        }
        context.output(
          await context.request('projects.create', {
            title,
            goal,
            workspace: options.workspace,
            profile: options.profile,
            requestKey: options.key,
            ...(options.capture === undefined ? {} : { captureEnabled: options.capture === 'on' }),
          }),
        );
      },
    );
  mutation(projects.command('plan <projectId>').description('Предложить или пересмотреть план'))
    .option('--feedback <text>', 'что изменить в плане')
    .option('--goal <text>', 'уточнённая цель')
    .action(
      async (projectId: string, options: MutationOptions & { feedback?: string; goal?: string }) =>
        context.output(
          await context.request('projects.plan', {
            ...reference(projectId, options),
            feedback: options.feedback,
            goal: options.goal,
          }),
        ),
    );
  mutation(projects.command('edit <projectId>').description('Заменить план содержимым JSON-файла'))
    .requiredOption('--file <file>', 'файл плана без поля version')
    .action(async (projectId: string, options: MutationOptions & { file: string }) =>
      context.output(
        await context.request('projects.editPlan', {
          ...reference(projectId, options),
          plan: projectPlanSchema.parse(JSON.parse(await readFile(options.file, 'utf8'))),
        }),
      ),
    );
  mutation(
    projects
      .command('accept-plan <projectId>')
      .description('Принять просмотренный план и начать выполнение'),
  )
    .requiredOption('--plan-version <number>', 'проверенная версия плана', integer)
    .action(async (projectId: string, options: MutationOptions & { planVersion: number }) =>
      context.output(
        await context.request('projects.acceptPlan', {
          ...reference(projectId, options),
          expectedPlanVersion: options.planVersion,
        }),
      ),
    );
  for (const action of ['pause', 'cancel', 'recheck'] as const) {
    mutation(
      projects.command(action + ' <projectId>').description(
        {
          pause: 'Приостановить проект',
          cancel: 'Остановить проект',
          recheck: 'Повторить проверку результата',
        }[action],
      ),
    ).action(async (projectId: string, options: MutationOptions) =>
      context.output(await context.request(`projects.${action}`, reference(projectId, options))),
    );
  }
  mutation(projects.command('resume <projectId>').description('Продолжить приостановленный проект'))
    .option('--accept-changes', 'подтвердить просмотренные внешние изменения', false)
    .action(async (projectId: string, options: MutationOptions & { acceptChanges: boolean }) =>
      context.output(
        await context.request('projects.resume', {
          ...reference(projectId, options),
          acceptChanges: options.acceptChanges,
        }),
      ),
    );
  mutation(
    projects
      .command('message <projectId> <stageId> <text>')
      .description('Передать уточнение работающему этапу'),
  ).action(async (projectId: string, stageId: string, message: string, options: MutationOptions) =>
    context.output(
      await context.request('projects.message', {
        ...reference(projectId, options),
        stageId,
        message,
      }),
    ),
  );
  mutation(
    projects
      .command('manual-check <projectId> <stageId>')
      .description('Зафиксировать результат ручной проверки'),
  )
    .requiredOption('--result-revision <revision>', 'проверенная ревизия файлов')
    .requiredOption('--outcome <passed|failed>', 'результат проверки')
    .option('--comment <text>', 'что проверено', '')
    .action(
      async (
        projectId: string,
        stageId: string,
        options: MutationOptions & { resultRevision: string; outcome: string; comment: string },
      ) => {
        if (options.outcome !== 'passed' && options.outcome !== 'failed')
          throw new InvalidArgumentError('Результат: passed или failed.');
        context.output(
          await context.request('projects.manualCheck', {
            ...reference(projectId, options),
            stageId,
            expectedResultRevision: options.resultRevision,
            outcome: options.outcome,
            comment: options.comment,
          }),
        );
      },
    );
  mutation(projects.command('accept <projectId>').description('Принять проверенный итог проекта'))
    .requiredOption('--result-revision <revision>', 'проверенная ревизия файлов')
    .action(async (projectId: string, options: MutationOptions & { resultRevision: string }) =>
      context.output(
        await context.request('projects.accept', {
          ...reference(projectId, options),
          expectedResultRevision: options.resultRevision,
        }),
      ),
    );
  mutation(
    projects
      .command('archive <projectId>')
      .description('Скрыть завершённый проект из основного списка'),
  )
    .option('--restore', 'вернуть из архива', false)
    .action(async (projectId: string, options: MutationOptions & { restore: boolean }) =>
      context.output(
        await context.request('projects.archive', {
          ...reference(projectId, options),
          archived: !options.restore,
        }),
      ),
    );
  projects
    .command('purge-preview <projectId>')
    .description('Показать состав полного удаления')
    .action(async (projectId: string) =>
      context.output(await context.request('projects.purgePreview', { projectId })),
    );
  mutation(
    projects.command('purge <projectId>').description('Удалить проект и связанные задачи навсегда'),
  )
    .requiredOption('--preview-token <token>', 'токен из projects purge-preview')
    .action(async (projectId: string, options: MutationOptions & { previewToken: string }) =>
      context.output(
        await context.request('projects.purge', {
          ...reference(projectId, options),
          previewToken: options.previewToken,
        }),
      ),
    );
  mutation(
    projects
      .command('resolve <projectId> <runId> <invocationId>')
      .description('Подтвердить проверенный человеком исход прерванной операции'),
  )
    .requiredOption('--result <text>', 'фактический результат проверки')
    .requiredOption('--outcome <succeeded|failed>', 'подтверждённый исход')
    .action(
      async (
        projectId: string,
        runId: string,
        invocationId: string,
        options: MutationOptions & { result: string; outcome: string },
      ) => {
        if (!['succeeded', 'failed'].includes(options.outcome))
          throw new InvalidArgumentError('Исход: succeeded или failed.');
        context.output(
          await context.request('projects.resolve', {
            ...reference(projectId, options),
            runId,
            invocationId,
            result: options.result,
            succeeded: options.outcome === 'succeeded',
          }),
        );
      },
    );
}
