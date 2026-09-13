import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import type { TaskView } from '../types.js';
import { brandName } from '../branding.js';
import type { FeedTab } from './task-feed.js';
import { workspaceLine } from './task-layout.js';
import { terminalText } from './screen.js';
import { boxLine, fitLine, rule, statusBadge } from './terminal-layout.js';

export const taskTabs: Array<{ id: FeedTab; label: string; title: string }> = [
  { id: 'all', label: 'Все', title: 'Ход задачи' },
  { id: 'log', label: 'Журнал', title: 'Журнал' },
  { id: 'reasoning', label: 'Мысли', title: 'Пояснения модели' },
  { id: 'text', label: 'Ответ', title: 'Ответ' },
];

/** Ограничивает длину строки чтения и оставляет поля в широком окне. */
export function taskGeometry(columns: number): { width: number; margin: string; content: number } {
  const margin = columns >= 70 ? '  ' : '';
  const width = Math.max(5, Math.min(108, columns - margin.length * 2 - 1));
  return { width, margin, content: Math.max(1, width - 4) };
}

export function taskHeader(
  status: TaskView | undefined,
  width: number,
  height: number,
  tab: FeedTab,
): string[] {
  const task = terminalText(status?.task ?? 'Загружаю задачу…').replace(/\s+/g, ' ');
  const titleLines = wrapAnsi(task, Math.max(1, width - 4), { hard: true }).split('\n');
  const titleCount = height >= 30 ? 2 : 1;
  const title = titleLines
    .slice(0, titleCount)
    .map((line, index) =>
      index === titleCount - 1 && titleLines.length > titleCount
        ? fitLine(line + '…', width - 4)
        : line,
    );
  const agents = status?.agents ?? [];
  const working = agents.filter((agent) => agent.status === 'running').length;
  const team =
    agents.length > 1
      ? `Участников: ${agents.length}` +
        (status && ['running', 'awaiting_approval'].includes(status.status)
          ? ` · в работе: ${working}`
          : '')
      : agents.length
        ? 'Роль: ' + terminalText(agents[0]!.role)
        : '';
  const rows = [
    color.cyan(color.bold(fitLine('[H] ' + brandName, width))),
    ...(height >= 30 ? [''] : []),
    rule(width, color.bold('Задача ' + (status?.runId.slice(0, 8) ?? '')), 'top'),
    ...title.map((line) => boxLine(color.bold(line), width)),
    boxLine(
      status?.deletedAt
        ? color.yellow('Скрыта · только чтение')
        : statusBadge(status?.status ?? 'running') +
            color.dim(
              ' · ' + terminalText(status?.profile ?? '') + ' · шаг ' + (status?.turns ?? 0),
            ),
      width,
    ),
    boxLine(color.dim(workspaceLine(status?.workspace ?? 'загружается', width - 3)), width),
    ...(team ? [boxLine(color.dim(team), width)] : []),
    rule(width, '', 'bottom'),
    ...(height >= 30 ? [''] : []),
    ' ' +
      taskTabs
        .map((item) =>
          item.id === tab
            ? color.bold(color.inverse('[' + item.label + ']'))
            : color.dim(item.label),
        )
        .join('  '),
  ];
  return rows;
}

export function taskFooter(width: number, active: boolean): string[] {
  const key = (name: string, action: string): string =>
    color.bold(name) + color.dim(' — ' + action);
  const primary = key('Enter', 'действия') + ' · ' + key('Esc', 'назад');
  const navigation =
    key('Tab', 'раздел') +
    ' · ' +
    key(width < 65 ? '↑↓' : '↑↓/PgUp/PgDn', 'прокрутка') +
    ' · ' +
    key('End', 'конец');
  return [
    rule(width, color.bold('Управление')),
    ' ' + primary + (active && width >= 65 ? ' · ' + key('Ctrl+C', 'остановить') : ''),
    ' ' + navigation,
    ...(active && width < 65 ? [' ' + key('Ctrl+C', 'остановить') + ' · PgUp/PgDn'] : []),
  ];
}
