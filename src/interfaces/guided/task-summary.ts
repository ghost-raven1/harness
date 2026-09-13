import wrapAnsi from 'wrap-ansi';
import type { StatusView } from '../types.js';
import { labels } from '../ui.js';
import { hasInterruptedOperations } from './interrupted-task.js';
import { terminalText } from './screen.js';
import { workspaceLine } from './task-layout.js';
import { fitLine, menuSummaryRoom, menuWidth } from './terminal-layout.js';

/** Сокращённая карточка сохраняет абзацы ответа и место для состояния и ошибок. */
export function taskSummary(
  status: StatusView,
  columns = process.stdout.columns || 80,
  rows = process.stdout.rows || 24,
  actionNotice = '',
): string {
  const width = Math.max(1, menuWidth(columns) - 4);
  const room = menuSummaryRoom(rows, 12);
  const wrap = (text: string): string[] =>
    wrapAnsi(terminalText(text.replace(/\r\n?/g, '\n')), width, {
      hard: true,
      trim: false,
    }).split('\n');
  const limit = (lines: string[], count: number): string[] => {
    const visible = lines.slice(0, Math.max(0, count));
    if (visible.length && lines.length > visible.length)
      visible[visible.length - 1] = fitLine(visible.at(-1)! + '…', width);
    return visible;
  };
  const state = labels[status.status] ?? status.status;
  const error = taskNotice(status);
  const task = status.task ? wrap(status.task) : [];
  if (room < 5)
    return limit(
      [state, ...(actionNotice ? wrap(actionNotice) : []), ...(error ? wrap(error) : []), ...task],
      room,
    ).join('\n');

  const metadata = [workspaceLine(status.workspace, width), state];
  if (status.pendingMessages) metadata.push('Сообщений в очереди: ' + status.pendingMessages);
  if (status.deletedAt)
    metadata.push(
      hasInterruptedOperations(status)
        ? 'Убрана из списка · нужна проверка операции'
        : 'Скрыта · только чтение',
    );
  const details = metadata.flatMap(wrap);
  const action = actionNotice
    ? limit(
        wrap(actionNotice),
        Math.min(2, room - details.length - (task.length ? 1 : 0) - (error ? 1 : 0)),
      )
    : [];
  const notice = error
    ? limit(wrap(error), Math.min(3, room - details.length - action.length - (task.length ? 1 : 0)))
    : [];
  const heading = [
    ...limit(task, Math.min(2, room - details.length - notice.length - action.length)),
    ...details,
    ...notice,
    ...action,
  ];
  if (!status.result) return heading.join('\n');

  const answer = wrap(status.result.replace(/\n+$/, ''));
  const available = room - heading.length;
  if (answer.length + 1 <= available) return [...heading, '', ...answer].join('\n');
  const hint = wrap('Полный ответ — «Прочитать ответ»');
  if (available <= hint.length) return [...heading, ...limit(hint, available)].join('\n');
  const preview = limit(answer, available - hint.length - 1);
  return [...heading, '', ...preview, ...hint].join('\n');
}

/** Старые сообщения о местных квотах остаются в журнале, но не мешают продолжению. */
function taskNotice(status: StatusView): string | undefined {
  if (status.status === 'paused' && status.iterations?.pausedByLimit)
    return (
      'Предел шагов достигнут. «Продолжить после паузы» даст ещё ' +
      status.iterations.limit +
      ' шагов.'
    );
  const previousQuota =
    status.status === 'paused' &&
    [
      'Достигнута квота этой задачи. Она сохранена на паузе; можно добавить токены и продолжить.',
      'Достигнута общая дневная квота API. Новых запросов нет. Увеличьте квоту в настройках или продолжите после смены суток UTC.',
    ].includes(status.error ?? '');
  return previousQuota
    ? 'Прежняя квота отключена. Выберите «Продолжить после паузы».'
    : status.error;
}
