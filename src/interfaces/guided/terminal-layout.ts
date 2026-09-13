import color from 'picocolors';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { labels } from '../ui.js';

/** Ограничивает длину строки чтения в широком терминале. */
export function menuWidth(columns: number): number {
  return Math.max(1, Math.min(columns - 1, 108));
}

/** Оставляет место для действий и клавиш даже у подробной карточки задачи. */
export function menuSummaryRoom(height: number, requested = 7): number {
  return Math.max(0, Math.min(requested, height - 14));
}

/** Ограничивает строку по ширине символов терминала, сохраняя цвет и явное многоточие. */
export function fitLine(text: string, width: number): string {
  if (width < 1) return '';
  const line = text.replace(/\n/g, ' ');
  if (stringWidth(line) <= width) return line;
  if (width === 1) return '…';
  return (
    wrapAnsi(line, width - 1, { hard: true, trim: false })
      .split('\n')[0]!
      .trimEnd() + '…'
  );
}

/** Рамка и отступы остаются ровными с кириллицей, emoji, CJK и отключёнными цветами. */
export function boxLine(text: string, width: number): string {
  const inside = Math.max(1, width - 4);
  const value = fitLine(text, inside);
  return (
    color.dim('│') + ' ' + value + ' '.repeat(inside - stringWidth(value)) + ' ' + color.dim('│')
  );
}

export function rule(
  width: number,
  label = '',
  edge: 'top' | 'bottom' | 'plain' = 'plain',
): string {
  const [left, right] = edge === 'top' ? ['╭', '╮'] : edge === 'bottom' ? ['╰', '╯'] : ['─', '─'];
  const title = label ? fitLine(' ' + label + ' ', Math.max(0, width - 4)) : '';
  return (
    color.dim(left + '─') +
    title +
    color.dim('─'.repeat(Math.max(0, width - stringWidth(title) - 3)) + right)
  );
}

export function statusBadge(status: string): string {
  const label = ' ' + (labels[status] ?? status) + ' ';
  if (status === 'completed') return color.bgGreen(color.black(label));
  if (status === 'failed') return color.bgRed(color.white(label));
  if (['cancelled', 'paused', 'awaiting_approval'].includes(status))
    return color.bgYellow(color.black(label));
  return color.bgCyan(color.black(label));
}
