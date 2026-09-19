import { Command } from 'commander';
import * as prompts from '@clack/prompts';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { selected, watch, statusCard, decideApprovals, note } from '../ui.js';
import type { CliContext, RunOptions, ServiceInfo, StatusView, RunSummary } from '../types.js';
import { deleteTask } from '../guided/delete-task.js';
import { purgeTask } from '../guided/purge-task.js';
import { commandPage } from '../guided/screen.js';
import { liveSelect } from '../guided/live-select.js';
import { prepareTask } from '../guided/new-task.js';
import { completeResult } from '../result-client.js';

/** Собирает параметры задачи и передаёт её единственному локальному сервису. */
export async function beginRun(
  context: CliContext,
  messageText?: string,
  options: RunOptions = {},
): Promise<void> {
  if (options.stdin) {
    if (messageText || process.stdin.isTTY)
      throw new Error('Передайте задачу только через перенаправленный stdin.');
    messageText = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      messageText += String(chunk);
      if (messageText.length > 100000)
        throw new Error('Задача из stdin превышает 100 000 символов.');
    }
  }
  if (messageText === undefined && !context.interactive())
    throw new Error('Укажите текст задачи аргументом');

  if (context.interactive() && (!options.profile || !options.workspace)) {
    const service = await context.request<ServiceInfo>('system.info');
    if (!options.profile) {
      commandPage('', false);
      options.profile = selected(
        await liveSelect({
          title: 'Новая задача · модель',
          load: async () => ({
            message: 'Профиль модели',
            options: service.profiles.map((profile) => ({
              value: profile.id,
              label: `${profile.id} · ${profile.model}`,
              hint: profile.configured ? profile.provider : 'ключ не настроен',
            })),
          }),
          initialValue: service.defaultProfile,
        }),
      );
    }
    if (!options.workspace) {
      commandPage('', false);
      options.workspace = selected(
        await liveSelect({
          title: 'Новая задача · папка',
          load: async () => ({
            message: 'Рабочая папка',
            options: service.workspaces.map((workspace) => ({
              value: workspace,
              label: workspace,
            })),
          }),
        }),
      );
    }
  }

  const result = await prepareTask(context, {
    text: messageText,
    requestKey: options.key,
    scope: {
      workspace: resolve(options.workspace ?? process.cwd()),
      profile: options.profile,
      sessionId: options.session,
    },
  });
  if (context.interactive()) commandPage('Задача создана');
  if (options.detach) {
    context.output(result);
    return;
  }
  await watch(context.directory(), result.runId, context.json());
}

/** Подключает команды задач; решения о побочных эффектах требуют интерактивного ввода. */
export function registerRunCommands(program: Command, context: CliContext): void {
  program
    .command('answer <runId>')
    .description('Вывести полный ответ; вывод можно перенаправить в файл')
    .action(async (runId: string) => {
      const status = await context.request<StatusView>('runtime.status', { runId });
      const full = await completeResult(context, status);
      if (context.json()) context.output({ runId, result: full.result });
      else process.stdout.write((full.result ?? 'Ответ ещё не получен.') + '\n');
    });
  program
    .command('delete <runId>')
    .description('Убрать задачу из списка, сохранив её историю и файлы')
    .option('--yes', 'подтвердить скрытие и остановку активной задачи')
    .action(async (runId: string, options: { yes?: boolean }) => {
      if (!options.yes && !context.interactive())
        throw new Error('Для удаления укажите --yes или откройте интерактивный CLI.');
      const status = await context.request<StatusView>('runtime.status', { runId });
      const deleted = await deleteTask(context, status, options.yes);
      context.output({ deleted, runId });
    });
  program
    .command('purge <runId>')
    .description('Удалить навсегда всю переписку задачи и связанные знания')
    .option('--preview', 'показать состав удаления и токен подтверждения')
    .option('--confirm <token>', 'подтвердить именно состав из --preview')
    .action(async (runId: string, options: { preview?: boolean; confirm?: string }) => {
      if (options.preview && options.confirm)
        throw new Error('Выберите --preview или --confirm, а не оба сразу.');
      if (options.preview) {
        context.output(await context.request('runtime.purgePreview', { runId }));
        return;
      }
      if (options.confirm) {
        context.output(
          await context.request('runtime.purge', { runId, previewToken: options.confirm }),
        );
        return;
      }
      if (!context.interactive())
        throw new Error(
          'Сначала выполните purge с --preview, затем передайте его токен через --confirm.',
        );
      const status = await context.request<StatusView>('runtime.status', { runId });
      context.output({ purged: await purgeTask(context, status), runId });
    });
  program
    .command('run [message]')
    .description('Начать задачу')
    .option('--workspace <path>', 'рабочая папка')
    .option('--profile <id>', 'профиль модели')
    .option('--session <id>', 'продолжить сессию')
    .option('--key <key>', 'ключ повторного запроса')
    .option('--stdin', 'прочитать задачу из стандартного ввода')
    .option('--detach', 'вернуть ID без наблюдения')
    .action((messageText: string | undefined, options: RunOptions) =>
      beginRun(context, messageText, options),
    );

  program
    .command('status [runId]')
    .description('Список запусков или состояние задачи')
    .option('--watch', 'наблюдать до результата')
    .action(async (runId: string | undefined, options: { watch?: boolean }) => {
      if (!runId) {
        const runs: RunSummary[] = [];
        for (let offset = 0; ; offset += 100) {
          const items = await context.request<RunSummary[]>('runtime.list', { offset, limit: 100 });
          runs.push(...items);
          if (items.length < 100) break;
        }
        if (process.stdout.isTTY && !context.json()) {
          note(
            runs.length
              ? runs.map((run) => run.task + '\n' + run.status + ' · ' + run.runId).join('\n\n')
              : 'Запусков пока нет. Начните с harness run.',
            'Последние задачи',
          );
        } else context.output(runs);
        return;
      }
      if (options.watch) {
        await watch(context.directory(), runId, context.json());
        return;
      }
      const status = await context.request<StatusView>('runtime.status', { runId });
      if (process.stdout.isTTY && !context.json()) statusCard(status);
      else context.output(status);
    });

  program
    .command('cancel <runId>')
    .description('Отменить задачу и её ветки')
    .action(async (runId: string) =>
      context.output(await context.request('runtime.cancel', { runId })),
    );
  program
    .command('resume <runId>')
    .description('Продолжить восстановленный запуск')
    .action(async (runId: string) => {
      await context.request('runtime.resume', { runId });
      await watch(context.directory(), runId, context.json());
    });
  program
    .command('resolve-restore <runId>')
    .description('Проверить прерванное восстановление файлов без повторной записи')
    .action(async (runId: string) => {
      if (!context.interactive())
        throw new Error('Нужен интерактивный терминал для проверки файла');
      const { reviewRestorations } = await import('../guided/restore-review.js');
      const status = await context.request<StatusView>('runtime.status', { runId });
      context.output({ resolved: await reviewRestorations(context, status) });
    });
  program
    .command('resolve <runId> <invocationId>')
    .description('Зафиксировать проверенный человеком результат прерванной записи')
    .requiredOption('--result-file <path>', 'файл с фактически установленным результатом')
    .option('--failed', 'операция завершилась ошибкой')
    .action(
      async (
        runId: string,
        invocationId: string,
        options: { resultFile: string; failed?: boolean },
      ) => {
        if (!context.interactive())
          throw new Error('Нужен интерактивный терминал для подтверждения результата');
        const result = await readFile(resolve(options.resultFile), 'utf8');
        note(result, 'Проверенный результат операции ' + invocationId);
        const confirmed = selected(
          await prompts.confirm({
            message: 'Вы проверили фактический результат операции?',
            initialValue: false,
            active: 'Да',
            inactive: 'Нет',
          }),
        );
        if (!confirmed) return;
        context.output(
          await context.request('runtime.resolve', {
            runId,
            invocationId,
            result,
            succeeded: !options.failed,
          }),
        );
      },
    );
  program
    .command('approvals')
    .description('Рассмотреть ожидающие разрешения')
    .action(async () => {
      if (context.interactive()) await decideApprovals(context.directory());
      else context.output(await context.request('approvals.list'));
    });
}
