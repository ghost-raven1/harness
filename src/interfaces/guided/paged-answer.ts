import type { CliContext, StatusView } from '../types.js';

import { isMissingResource } from '../../shared/resource-errors.js';
import { readText } from './text-reader.js';
import { liveSelect } from './live-select.js';
import { labels, selected } from '../ui.js';

/** Большой ответ читается частями: терминал не переносит мегабайты текста на каждом обновлении. */
export async function showPagedAnswer(context: CliContext, initial: StatusView): Promise<void> {
  const cursors = [0];
  let index = 0;
  while (true) {
    const cursor = cursors[index]!;
    const part = await context.request('runtime.result', {
      runId: initial.runId,
      cursor,
    });
    const snapshot = async () => {
      const current = await context.request('runtime.status', { runId: initial.runId });
      if (current.resultLength !== part.total)
        throw new Error('Ответ изменился. Вернитесь к задаче и откройте его заново.');
      return {
        tabs: [{ id: 'answer', label: 'Ответ · часть ' + (index + 1), text: part.text }],
        subtitle: current.deletedAt ? 'Скрыта · только чтение' : labels[current.status],
        notice: part.hasMore ? 'Есть следующая часть' : 'Конец ответа',
      };
    };
    const first = await snapshot();
    const action = await readText('Ответ модели', first.tabs, {
      ...first,
      actionLabel: 'выбрать часть',
      load: snapshot,
      exitOnError: (error) => isMissingResource(error, 'task'),
    });
    if (action === 'back') return;
    const choice = selected(
      await liveSelect({
        title: 'Части ответа',
        exitOnError: (error) => isMissingResource(error, 'task'),
        load: async () => {
          await context.request('runtime.status', { runId: initial.runId });
          return {
            message: 'Какую часть открыть?',
            options: [
              ...(part.hasMore ? [{ value: 'next', label: 'Следующая часть →' }] : []),
              ...(index > 0 ? [{ value: 'previous', label: '← Предыдущая часть' }] : []),
              { value: 'current', label: 'Продолжить чтение этой части' },
              { value: 'back', label: '← К задаче' },
            ],
          };
        },
      }),
    );
    if (choice === 'back') return;
    if (choice === 'previous') index--;
    if (choice === 'next') {
      cursors[index + 1] = part.nextCursor;
      index++;
    }
  }
}
