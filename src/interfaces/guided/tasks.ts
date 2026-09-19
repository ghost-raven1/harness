import { restoreFile } from './file-preview.js';
import { manageBudget } from './budget.js';
import { showIterationSettings } from './iterations.js';
import * as prompts from '@clack/prompts';
import type { CliContext, RunSummary, StatusView } from '../types.js';
import { labels, note, selected } from '../ui.js';
import { followRun } from './watch.js';
import { page, terminalText } from './screen.js';
import { deleteTask } from './delete-task.js';
import { purgeTask } from './purge-task.js';
import { checkInterrupted, hasInterruptedOperations } from './interrupted-task.js';
import { taskSummary } from './task-summary.js';
import { fitLine } from './terminal-layout.js';
import { showTaskDetails } from './task-details.js';
import { showTaskAnswer } from './task-answer.js';
import { liveSelect } from './live-select.js';
import { liveConfirm } from './live-confirm.js';
import type { Preferences } from './preferences.js';
import { prepareTask } from './new-task.js';
import { isMissingResource } from '../../shared/resource-errors.js';
import { showRemovedTask } from './task-removed.js';
import { saveAnswer } from './answer-export.js';
import { completeResult } from '../result-client.js';
import { canMessageTask, writeTaskMessage } from './task-message.js';
export { saveAnswer } from './answer-export.js';

/** Повторный вопрос остаётся в той же сессии; новая задача всегда получает отдельную историю. */
export async function newTask(
  context: CliContext,
  preferences: Pick<Preferences, 'workspace' | 'profile'>,
  previous?: StatusView,
): Promise<'archive' | undefined> {
  const interrupted = previous && ['cancelled', 'failed'].includes(previous.status);
  page(previous ? 'Продолжение задачи' : 'Новая задача');
  note(
    terminalText(previous?.workspace ?? preferences.workspace) +
      (interrupted
        ? '\n\nНачнётся новый этап с сохранённой перепиской. Текст ниже можно изменить.'
        : ''),
    'Рабочая папка этой задачи',
  );
  const result = await prepareTask(context, {
    title: interrupted
      ? 'С чего продолжить?'
      : previous
        ? 'Ваш ответ модели или следующий шаг'
        : 'Что нужно сделать?',
    initialValue: interrupted
      ? 'Продолжи исходную задачу. Учти результаты и проверь прерванные действия.'
      : undefined,
    previous,
    scope: {
      workspace: previous?.workspace ?? preferences.workspace,
      profile: previous?.profile ?? preferences.profile,
      sessionId: previous?.sessionId,
      expectedParentRunId: previous?.runId,
    },
  });
  const status = await followRun(context, result.runId);
  if (!status) return 'archive';
  if ((await taskActions(context, preferences, status)) === 'archive') {
    if (previous) return 'archive';
    await chooseTask(context, preferences);
  }
}

/** Листает весь архив и ищет ответы; скрытые задачи доступны по отдельному переключателю. */
export async function chooseTask(
  context: CliContext,
  preferences: Pick<Preferences, 'workspace' | 'profile'>,
): Promise<void> {
  let pageIndex = 0;
  let query = '';
  let includeDeleted = false;
  const loadHistory = () =>
    context.request<{
      active: RunSummary[];
      items: RunSummary[];
      page: number;
      pages: number;
      total: number;
    }>('runtime.history', { page: pageIndex, query, includeDeleted });
  while (true) {
    const runId = selected(
      await liveSelect({
        title: 'Мои задачи',
        load: async () => {
          const history = await loadHistory();
          return {
            summary:
              [
                query ? 'Поиск: ' + terminalText(query) : undefined,
                !history.active.length && !history.items.length
                  ? query
                    ? 'По этому запросу задач не найдено. Измените слова или сбросьте поиск.'
                    : 'Пока нет задач. Выберите «Новая задача» и опишите, что нужно сделать.'
                  : undefined,
              ]
                .filter(Boolean)
                .join('\n') || undefined,
            summaryTitle: query
              ? !history.active.length && !history.items.length
                ? 'Нет совпадений'
                : 'Поиск по истории'
              : 'Мои задачи',
            message:
              'Мои задачи · страница ' +
              (history.page + 1) +
              '/' +
              history.pages +
              ' · всего ' +
              (history.total + history.active.length) +
              (includeDeleted ? ' · включая скрытые' : ''),
            options: [
              ...(!history.active.length && !history.items.length && !query
                ? [{ value: 'new', label: 'Новая задача' }]
                : []),
              ...history.active.map((run) => ({
                value: run.runId,
                label: fitLine(
                  '● ' + terminalText(run.task).replace(/\s+/g, ' '),
                  Math.max(1, (process.stdout.columns || 80) - 20),
                ),
                hint: labels[run.status],
              })),
              ...history.items.map((run) => ({
                value: run.runId,
                label: fitLine(
                  (run.deletedAt ? '[скрыта] ' : '') + terminalText(run.task).replace(/\s+/g, ' '),
                  Math.max(1, (process.stdout.columns || 80) - 20),
                ),
                hint: run.deletedAt ? 'только чтение' : labels[run.status],
              })),
              { value: 'search', label: 'Найти задачу или ответ' },
              ...(query ? [{ value: 'clear', label: 'Сбросить поиск' }] : []),
              ...(history.page + 1 < history.pages
                ? [{ value: 'next', label: 'Следующая страница →' }]
                : []),
              ...(history.page > 0 ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
              {
                value: 'hidden',
                label: includeDeleted
                  ? 'Не показывать убранные задачи'
                  : 'Показать убранные задачи',
              },
              { value: 'back', label: '← В главное меню' },
            ],
          };
        },
      }),
    );
    if (runId === 'back') return;
    if (runId === 'new') {
      try {
        if ((await newTask(context, preferences)) === 'archive') continue;
        return;
      } catch (error) {
        if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL') continue;
        throw error;
      }
    }
    if (runId === 'hidden') {
      includeDeleted = !includeDeleted;
      pageIndex = 0;
      continue;
    }
    if (runId === 'next' || runId === 'previous') {
      const history = await loadHistory();
      pageIndex = Math.max(0, history.page + (runId === 'next' ? 1 : -1));
      continue;
    }
    if (runId === 'clear') {
      query = '';
      pageIndex = 0;
      continue;
    }
    if (runId === 'search') {
      page('Поиск задач');
      query = selected(
        await prompts.text({
          message: 'Слова из задачи, ответа или пути к папке',
          initialValue: query,
          validate: (value) => (value.length <= 200 ? undefined : 'Не более 200 символов'),
        }),
      ).trim();
      pageIndex = 0;
      continue;
    }
    const status = await followRun(context, runId, { inspect: context.interactive() });
    if (!status) continue;
    if (status && (await taskActions(context, preferences, status)) === 'archive') continue;
    return;
  }
}

/** Показывает действия, допустимые для текущего состояния и режима скрытой задачи. */
function taskActionOptions(status: StatusView) {
  const readOnly = !!status.deletedAt || !!status.recoveryRequired;
  const active = ['running', 'awaiting_approval', 'paused'].includes(status.status);
  return [
    ...(canMessageTask(status) ? [{ value: 'message', label: 'Написать модели' }] : []),
    ...(hasInterruptedOperations(status)
      ? [{ value: 'review', label: 'Проверить прерванную операцию' }]
      : []),
    ...(!active && !readOnly && !hasInterruptedOperations(status)
      ? [
          {
            value: 'continue',
            label: ['cancelled', 'failed'].includes(status.status)
              ? 'Продолжить задачу'
              : 'Ответить или продолжить',
            hint: 'с сохранённой перепиской',
          },
        ]
      : []),
    ...(!readOnly && ['running', 'awaiting_approval'].includes(status.status)
      ? [{ value: 'watch', label: 'Вернуться к выполнению задачи' }]
      : []),
    ...(!readOnly && status.status === 'paused'
      ? [{ value: 'resume', label: 'Продолжить после паузы' }]
      : []),
    ...(status.result
      ? [
          { value: 'answer', label: 'Прочитать ответ' },
          { value: 'save', label: 'Сохранить ответ в папку проекта' },
        ]
      : []),
    ...(!readOnly && status.result
      ? [
          {
            value: 'feedback',
            label: 'Оценить результат',
            hint: 'помочь накопить проверенный опыт',
          },
        ]
      : []),
    ...(!readOnly && active ? [{ value: 'cancel', label: 'Остановить эту задачу' }] : []),
    ...(!readOnly && !active && status.fileChanges?.some((item) => item.status === 'applied')
      ? [{ value: 'restore', label: 'Посмотреть изменения и восстановить файл' }]
      : []),
    ...(!readOnly ? [{ value: 'budget', label: 'Расход токенов задачи' }] : []),
    ...(!readOnly ? [{ value: 'iterations', label: 'Предел шагов задачи' }] : []),
    { value: 'details', label: 'Технические подробности' },
    { value: 'history', label: 'Журнал, мысли и полный ответ' },
    ...(!readOnly && !active ? [{ value: 'drafts', label: 'Черновики сообщений' }] : []),
    ...(!readOnly ? [{ value: 'delete', label: 'Убрать из списка' }] : []),
    ...(!active && !status.recoveryRequired ? [{ value: 'purge', label: 'Удалить навсегда' }] : []),
    ...(!readOnly ? [{ value: 'archive', label: '← К списку задач' }] : []),
    { value: 'back', label: readOnly ? '← К списку задач' : '← В главное меню' },
  ];
}

/** Перед действием перечитывает задачу, чтобы не применять устаревший выбор другого окна. */
async function taskActions(
  context: CliContext,
  preferences: Pick<Preferences, 'workspace' | 'profile'>,
  initial: StatusView,
): Promise<'archive' | undefined> {
  const runId = initial.runId;
  let notice = '';
  let menuStatus = initial;
  try {
    while (true) {
      const previousNotice = notice;
      notice = '';
      const action = selected(
        await liveSelect({
          title: 'Задача · ' + runId.slice(0, 8),
          exitOnError: (error) => isMissingResource(error, 'task'),
          load: async () => {
            const status = await context.request<StatusView>('runtime.status', { runId });
            menuStatus = status;
            return {
              message: 'Что дальше?',
              summary: taskSummary(status, undefined, undefined, previousNotice),
              summaryTitle: 'Состояние задачи',
              summaryRows: 12,
              options: taskActionOptions(status),
            };
          },
        }),
      );
      if (action === 'archive') return 'archive';
      if (action === 'back') return menuStatus.deletedAt ? 'archive' : undefined;
      const status = await context.request<StatusView>('runtime.status', { runId });
      if (!taskActionOptions(status).some((option) => option.value === action)) {
        notice = 'Состояние изменилось в другом окне. Выберите актуальное действие.';
        continue;
      }

      if (action === 'message' || action === 'drafts') {
        notice = await writeTaskMessage(context, status);
        continue;
      }

      if (action === 'delete' && (await deleteTask(context, status))) return;
      if (action === 'purge' && (await purgeTask(context, status))) return 'archive';
      if (action === 'review') {
        try {
          if (await checkInterrupted(context, status)) notice = 'Результаты проверки сохранены.';
        } catch (error) {
          if (!(error instanceof Error && error.message === 'INTERACTIVE_CANCEL')) throw error;
        }
        continue;
      }
      if (action === 'history') await followRun(context, status.runId, { inspect: true });
      if (action === 'answer' && (await showTaskAnswer(context, status)) === 'removed')
        return 'archive';
      if (action === 'continue') {
        try {
          return await newTask(context, preferences, status);
        } catch (error) {
          if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL') continue;
          throw error;
        }
      }
      if (action === 'restore') await restoreFile(context, status.runId);
      if (action === 'budget' && (await manageBudget(context, status)) === 'removed')
        return 'archive';
      if (action === 'iterations' && (await showIterationSettings(context, runId)) === 'removed')
        return 'archive';
      if (action === 'details' && (await showTaskDetails(context, status)) === 'removed')
        return 'archive';
      if (action === 'save') {
        try {
          notice = 'Ответ сохранён: ' + (await saveAnswer(await completeResult(context, status)));
        } catch (error) {
          notice = error instanceof Error ? error.message : 'Ответ не сохранён. Повторите попытку.';
        }
      }
      if (action === 'feedback') {
        page('Оценка результата');
        notice = await feedback(context, status.runId);
      }
      if (action === 'cancel') {
        const yes = selected(
          (await liveConfirm({
            title: 'Остановка задачи',
            message: 'Остановить задачу и её подзадачи?',
            body: (status.task ?? runId) + '\n\nПапка: ' + status.workspace,
            active: 'Остановить',
            inactive: 'Продолжить работу',
            load: async () => {
              const current = await context.request<StatusView>('runtime.status', { runId });
              const available =
                !current.deletedAt &&
                ['running', 'awaiting_approval', 'paused'].includes(current.status);
              return {
                available,
                detail: available
                  ? (labels[current.status] ?? current.status)
                  : 'Задача уже остановлена или скрыта',
              };
            },
          })) ?? false,
        );
        if (yes) {
          const current = await context.request<StatusView>('runtime.status', { runId });
          if (
            !current.deletedAt &&
            ['running', 'awaiting_approval', 'paused'].includes(current.status)
          )
            await context.request('runtime.cancel', { runId });
        }
      }
      if (action === 'resume') {
        if (!(await checkInterrupted(context, status))) continue;
        const current = await context.request<StatusView>('runtime.status', { runId });
        if (current.deletedAt || current.status !== 'paused') continue;
        await context.request('runtime.resume', { runId });
      }
      if (action === 'watch' || action === 'resume') {
        const result = await followRun(context, status.runId);
        if (!result) return;
      }
    }
  } catch (error) {
    if (!isMissingResource(error, 'task')) throw error;
    await showRemovedTask();
    return 'archive';
  }
}

/** Записывает только явно выбранную оценку пользователя с его пояснением. */
async function feedback(context: CliContext, runId: string): Promise<string> {
  const positive = selected(
    await prompts.select<boolean | 'skip'>({
      message: 'Вы проверили результат?',
      options: [
        { value: true, label: 'Да, задача выполнена правильно' },
        { value: false, label: 'Нашёл ошибку' },
        { value: 'skip', label: 'Пока не проверял' },
      ],
    }),
  );
  if (positive === 'skip') return '';
  const text = selected(
    await prompts.text({
      message: 'Что именно вы проверили или что не сработало?',
      validate: (v) => (v.trim() ? undefined : 'Коротко опишите проверку'),
    }),
  );
  const current = await context.request<StatusView>('runtime.status', { runId });
  if (current.deletedAt) return 'Задача скрыта в другом окне. Отзыв не отправлен.';
  await context.request('learning.feedback', { runId, positive, text });
  return 'Отзыв сохранён. Опыт применяется только после проверки.';
}
