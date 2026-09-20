import { InvalidArgumentError, type Command } from 'commander';
import type { CliContext } from '../types.js';
import { supportsInsights } from '../guided/specialists/capability.js';
import { browseSpecialists } from '../guided/specialists/screens.js';
import { browseProjectSpecialists } from '../guided/specialists/project.js';
import { runSummary, usageText } from '../guided/specialists/format.js';
import { terminalText } from '../guided/screen.js';

/** Неподдерживаемая команда не отправляется старому сервису. */
async function requireInsights(context: CliContext): Promise<void> {
  if (!(await supportsInsights(context)))
    throw new Error('Сервис не поддерживает сведения о специалистах. Обновите сервис Harness.');
}

/** Открывает живой экран в терминале или отдаёт типизированные данные автоматизации. */
export function registerInsightsCommand(program: Command, context: CliContext): void {
  program
    .command('insights <runId>')
    .description('Работа специалистов, время и токены задачи')
    .option(
      '--offset <number>',
      'смещение списка для --json, начиная с 0; страница — 50 специалистов',
      (value: string) => {
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
          throw new InvalidArgumentError('Нужно целое неотрицательное число.');
        return number;
      },
      0,
    )
    .action(async (runId: string, options: { offset: number }) => {
      await requireInsights(context);
      if (context.interactive() && !context.json()) {
        const status = await context.request('runtime.status', { runId });
        return browseSpecialists(context, runId, status.project);
      }
      const insights = await context.request('runtime.insights', {
        runId,
        agentOffset: options.offset,
        agentLimit: 50,
      });
      context.output(
        context.json()
          ? insights
          : terminalText(runSummary(insights) + '\n\n' + usageText(insights.usage)),
      );
    });
}

/** Проектная команда сохраняет раздельные попытки и ограничивает размер ответа страницей. */
export function registerProjectInsightsCommand(
  projects: Command,
  context: CliContext,
  integer: (value: string) => number,
): void {
  projects
    .command('insights <projectId>')
    .description('Специалисты по этапам и попыткам проекта')
    .option('--offset <number>', 'смещение страницы запусков', integer, 0)
    .action(async (projectId: string, options: { offset: number }) => {
      await requireInsights(context);
      if (context.interactive() && !context.json())
        return browseProjectSpecialists(context, projectId);
      context.output(
        await context.request('projects.insights', {
          projectId,
          offset: options.offset,
          limit: 20,
        }),
      );
    });
}
