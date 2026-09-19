import type { CliContext, StatusView } from '../types.js';
import { labels } from '../ui.js';
import { isMissingResource } from '../../shared/resource-errors.js';
import { readText, type ReaderSnapshot } from './text-reader.js';
import { showPagedAnswer } from './paged-answer.js';

/** Отличает полный ответ от первой части и предлагает отдельное чтение большого текста. */
function answerSnapshot(status: StatusView): ReaderSnapshot {
  return {
    tabs: [{ id: 'answer', label: 'Ответ', text: status.result ?? 'Ответ ещё не получен.' }],
    subtitle: status.deletedAt ? 'Скрыта · только чтение' : labels[status.status],
    ...(status.resultTruncated
      ? {
          notice: 'Получен большой ответ. Показана первая часть.',
          actionLabel: 'читать ответ по частям',
        }
      : {}),
  };
}

/** Полный ответ читается с начала; удаление очищает текст и возвращает к каталогу. */
export async function showTaskAnswer(
  context: CliContext,
  initial: StatusView,
): Promise<'back' | 'removed'> {
  let current = initial;
  try {
    while (true) {
      if (current.resultTruncated) {
        await showPagedAnswer(context, current);
        return 'back';
      }
      const snapshot = answerSnapshot(current);
      const action = await readText('Ответ модели', snapshot.tabs, {
        subtitle: snapshot.subtitle,
        load: async () => {
          current = await context.request('runtime.status', { runId: initial.runId });
          return answerSnapshot(current);
        },
        exitOnError: (error) => isMissingResource(error, 'task'),
      });
      if (action !== 'action') return 'back';
    }
  } catch (error) {
    if (!isMissingResource(error, 'task')) throw error;
    await readText('Задача удалена', [
      {
        id: 'removed',
        label: 'Задача',
        text: 'Задача удалена в другом окне. Esc — к списку задач.',
      },
    ]);
    return 'removed';
  }
}
