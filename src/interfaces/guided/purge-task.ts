import * as prompts from '@clack/prompts';
import type { CliContext, StatusView } from '../types.js';
import { selected } from '../ui.js';
import { explainError } from './errors.js';
import { liveConfirm } from './live-confirm.js';
import { page, backFromPage } from './screen.js';
import { readText } from './text-reader.js';

/** Удаляет всю переписку только после подтверждения её актуального состава. */
export async function purgeTask(context: CliContext, status: StatusView): Promise<boolean> {
  const load = () => context.request('runtime.purgePreview', { runId: status.runId });
  const preview = await load();
  if (!preview.available) {
    await readText('Удаление пока недоступно', [
      {
        id: 'reason',
        label: 'Что нужно сделать',
        text: preview.blockers.join('\n\n'),
      },
    ]);
    return false;
  }
  const confirmed = selected(
    (await liveConfirm({
      title: 'Удаление переписки',
      message: 'Удалить эту переписку навсегда?',
      body: [
        'Этапов задачи: ' + preview.runs,
        'Связанных уроков: ' + preview.lessons,
        'Сохранённых копий уроков в Harness: ' + preview.exports,
        'Резервных копий для отмены изменений: ' + preview.backups,
        '',
        'Будут удалены все продолжения этой задачи, ответы, журнал и связанные знания. Отменить удаление нельзя.',
        'Файлы проекта и сохранённые вами ответы останутся. Восстановление файлов через эту задачу станет недоступно.',
        '',
        'Задача: ' + (status.task ?? status.runId),
      ].join('\n'),
      active: 'Удалить навсегда',
      inactive: 'Оставить',
      load: async () => {
        const current = await load();
        const unchanged = current.previewToken === preview.previewToken;
        return {
          available: current.available && unchanged,
          detail: !current.available
            ? current.blockers.join(' ')
            : !unchanged
              ? 'Переписка изменилась. Вернитесь и откройте удаление заново.'
              : '',
        };
      },
    })) ?? false,
  );
  if (!confirmed) return false;
  try {
    await context.request('runtime.purge', {
      runId: status.runId,
      previewToken: preview.previewToken,
    });
  } catch (error) {
    await readText('Удаление не выполнено', [
      {
        id: 'error',
        label: 'Причина',
        text: explainError(error),
      },
    ]);
    return false;
  }
  page('Переписка удалена');
  prompts.log.success('Переписка и связанные знания удалены из Harness. Файлы проекта сохранены.');
  await backFromPage();
  return true;
}
