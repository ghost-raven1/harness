import { Command, Option } from 'commander';
import type { CliContext } from '../types.js';

/** Старому сервису не отправляются ни новые команды, ни расширенные поля запросов. */
export async function requireProjectDiffs(context: CliContext): Promise<void> {
  const info = await context.request('system.info');
  if (!info.capabilities?.includes('projects-diff-v1'))
    throw new Error(
      'Подключённый сервис не поддерживает сравнение файлов. Обновите сервис Harness.',
    );
}

/** Автоматизация использует те же непрозрачные ID и постраничное чтение, что живые экраны. */
export function registerProjectChangeCommands(
  projects: Command,
  context: CliContext,
  integer: (value: string) => number,
): void {
  projects
    .command('change-sets <projectId>')
    .description('Сохранённые интервалы изменений проекта')
    .option('--offset <number>', 'смещение страницы', integer, 0)
    .action(async (projectId: string, options: { offset: number }) => {
      await requireProjectDiffs(context);
      context.output(
        await context.request('projects.changeSets', { projectId, offset: options.offset }),
      );
    });
  projects
    .command('changes <projectId> <changeSetId>')
    .description('Список файлов выбранного интервала')
    .option('--offset <number>', 'смещение страницы', integer, 0)
    .action(async (projectId: string, changeSetId: string, options: { offset: number }) => {
      await requireProjectDiffs(context);
      context.output(
        await context.request('projects.changes', {
          projectId,
          changeSetId,
          offset: options.offset,
        }),
      );
    });
  projects
    .command('file-change <projectId> <changeSetId> <fileId>')
    .description('Страница построчных изменений или сохранённой стороны файла')
    .addOption(
      new Option('--view <view>', 'вид содержимого')
        .choices(['diff', 'before', 'after'])
        .default('diff'),
    )
    .option('--offset <number>', 'nextOffset предыдущей страницы', integer, 0)
    .action(
      async (
        projectId: string,
        changeSetId: string,
        fileId: string,
        options: { view: 'diff' | 'before' | 'after'; offset: number },
      ) => {
        await requireProjectDiffs(context);
        context.output(
          await context.request('projects.fileChange', {
            projectId,
            changeSetId,
            fileId,
            ...options,
          }),
        );
      },
    );
  projects
    .command('capture <projectId> <mode>')
    .description(
      'Сохранение содержимого будущих снимков: on или off; проект должен быть приостановлен',
    )
    .requiredOption('--revision <number>', 'текущая ревизия проекта', integer)
    .requiredOption('--key <key>', 'ключ неизменного повторного запроса')
    .action(async (projectId: string, mode: string, options: { revision: number; key: string }) => {
      if (mode !== 'on' && mode !== 'off')
        throw new Error('Укажите on для включения или off для отключения.');
      await requireProjectDiffs(context);
      context.output(
        await context.request('projects.changeCapture', {
          projectId,
          expectedRevision: options.revision,
          requestKey: options.key,
          enabled: mode === 'on',
        }),
      );
    });
}
