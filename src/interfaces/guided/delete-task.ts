import * as prompts from '@clack/prompts';
import type { CliContext, StatusView } from '../types.js';
import { labels, selected } from '../ui.js';
import { page, backFromPage } from './screen.js';
import { liveConfirm } from './live-confirm.js';

/** Удаление управляется человеком: работа останавливается до исключения из списка. */
export async function deleteTask(
  context: CliContext,
  status: StatusView,
  confirmed = false,
): Promise<boolean> {
  const active = ['running', 'awaiting_approval', 'paused'].includes(status.status);
  if (!confirmed) {
    confirmed = selected(
      (await liveConfirm({
        title: 'Убрать задачу из списка',
        message: active
          ? 'Остановить и убрать эту задачу из списка?'
          : 'Убрать эту задачу из списка?',
        body:
          (status.task ?? status.runId) +
          '\n\nЗадача останется в истории. Её можно найти через «Показать убранные задачи». Файлы проекта и накопленные знания сохранятся.',
        active: 'Убрать',
        inactive: 'Оставить',
        load: async () => {
          const current = await context.request<StatusView>('runtime.status', {
            runId: status.runId,
          });
          return {
            available: !current.deletedAt,
            detail: current.deletedAt
              ? 'Задача уже скрыта в другом окне'
              : (labels[current.status] ?? current.status),
          };
        },
      })) ?? false,
    );
  }
  if (!confirmed) return false;
  const current = await context.request<StatusView>('runtime.status', { runId: status.runId });
  if (current.deletedAt) return true;
  if (['running', 'awaiting_approval', 'paused'].includes(current.status))
    await context.request('runtime.cancel', { runId: status.runId });
  await context.request('runtime.delete', { runId: status.runId });
  if (!context.json()) {
    page('Задача убрана из списка');
    prompts.log.success('Задача убрана из списка. Её история сохранена.');
    await backFromPage();
  }
  return true;
}
