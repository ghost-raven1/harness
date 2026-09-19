import wrapAnsi from 'wrap-ansi';
import { terminalText } from './screen.js';
import type { TaskView } from '../types.js';
import type { FeedTab } from './task-feed.js';

/** Сокращает середину пути, оставляя название проекта видимым в узком терминале. */
export function workspaceLine(workspace: string, width: number): string {
  const path = terminalText(workspace).replace(/\s+/g, ' ');
  const available = Math.max(1, width - 'Папка: '.length - 1);
  const wrap = (text: string): string[] =>
    wrapAnsi(text, available, { hard: true, trim: false }).split('\n');
  if (wrap(path).length === 1) return 'Папка: ' + path;
  const parts = path.split(/[\\/]/).filter(Boolean);
  let suffix = parts.pop() ?? path;
  while (parts.length && wrap('…/' + parts.at(-1) + '/' + suffix).length === 1)
    suffix = parts.pop() + '/' + suffix;
  if (wrap('…/' + suffix).length > 1) suffix = wrap(suffix).at(-1) ?? suffix;
  return 'Папка: ' + (wrap('…/' + suffix).length === 1 ? '…/' : '') + suffix;
}

/** Завершённый запуск не обещает новые сообщения, если ответа или пояснений не было. */
export function emptyFeed(status: TaskView | undefined, tab: FeedTab): string {
  if (status?.recoveryRequired) return status.error ?? 'Ошибка сохранения. Перезапустите Harness.';
  const terminal = status && ['completed', 'failed', 'cancelled'].includes(status.status);
  if (tab === 'reasoning')
    return terminal
      ? 'В этой задаче модель не передала пояснения.'
      : 'Модель пока не передала пояснения.';
  if (tab === 'log') return terminal ? 'Событий выполнения нет.' : 'Ожидаю события выполнения…';
  if (status?.status === 'cancelled')
    return 'Итогового ответа нет.\nНажмите Enter и выберите «Продолжить задачу».';
  if (status?.status === 'failed')
    return 'Задача завершилась ошибкой. Нажмите Enter, чтобы посмотреть детали или продолжить.';
  if (status?.status === 'paused')
    return 'Задача приостановлена. Продолжение доступно через Enter.';
  if (status?.status === 'completed') return 'Ход завершён без текстового ответа.';
  return 'Ожидаю новые события…';
}
