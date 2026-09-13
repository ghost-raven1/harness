import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import type { TaskFeed, FeedTab } from './task-feed.js';
import { terminalText } from './screen.js';
import { emptyFeed } from './task-layout.js';
import { fitLine } from './terminal-layout.js';

interface ContentBlock {
  id: string;
  title: string;
  meta: string;
}
export interface ContentRow {
  block: ContentBlock;
  part: 'heading' | 'meta' | 'body' | 'gap';
  text: string;
}

/** Выделяет источник записи, чтобы при прокрутке не смешивать вывод разных агентов. */
function heading(block: ContentBlock, width: number, continued = false): string {
  const suffix = continued ? ' · продолжение' : '';
  return color.bold(fitLine('◆ ' + block.title, width - suffix.length) + color.dim(suffix));
}

/** Событие сохраняет собственный заголовок и автора даже при прокрутке внутри его текста. */
export function contentRows(feed: TaskFeed, width: number, tab: FeedTab): ContentRow[] {
  let entries = feed.items(tab);
  if (tab === 'text' && feed.status?.result)
    entries = [
      {
        id: 'result',
        kind: 'text',
        role: '',
        at: '',
        text:
          terminalText(feed.status.result) +
          (feed.status.resultTruncated
            ? '\n\nПоказана часть ответа. Enter → «Прочитать ответ».'
            : ''),
      },
    ];
  if (!entries.length)
    entries = [
      {
        id: 'empty',
        kind: tab === 'reasoning' ? 'reasoning' : 'text',
        role: '',
        at: '',
        text: emptyFeed(feed.status, tab),
      },
    ];
  return entries.flatMap((entry): ContentRow[] => {
    const source = terminalText(entry.text);
    const [first, ...rest] = source.split('\n');
    const title =
      entry.id === 'empty'
        ? 'Пока нет сообщений'
        : entry.kind === 'log'
          ? first!
          : entry.kind === 'reasoning'
            ? 'Пояснения модели'
            : entry.id === 'result'
              ? 'Последний ответ модели'
              : 'Ответ модели';
    const meta = [entry.at ? entry.at.slice(11, 19) : '', entry.role].filter(Boolean).join(' · ');
    const block: ContentBlock = { id: entry.id, title, meta };
    const body = entry.kind === 'log' ? rest.join('\n') : source;
    const lines = body
      ? wrapAnsi(body, Math.max(1, width - 2), { hard: true, trim: false }).split('\n')
      : [];
    return [
      { block, part: 'heading', text: heading(block, width) },
      ...(meta
        ? [{ block, part: 'meta' as const, text: color.dim(fitLine('  ' + meta, width)) }]
        : []),
      ...lines.map((line): ContentRow => ({ block, part: 'body', text: '  ' + line })),
      { block, part: 'gap', text: '' },
    ];
  });
}

/** Добавляет подпись продолжения вместо безымянного хвоста обрезанной операции. */
export function contentWindow(
  rows: ContentRow[],
  room: number,
  offset: number,
  width: number,
): string[] {
  const end = Math.min(rows.length, Math.max(room, rows.length - offset));
  let start = Math.max(0, end - room);
  while (rows[start]?.part === 'gap' && start < end) start++;
  const first = rows[start];
  let visible: string[];
  if (first && first.part !== 'heading' && room >= 3) {
    const after = rows[start + 2];
    if (after?.part === 'body' && after.block.id === first.block.id) {
      visible = [
        heading(first.block, width, true),
        color.dim(fitLine('  ' + (first.block.meta || 'Начало выше · ↑↓ для прокрутки'), width)),
        ...rows.slice(start + 2, end).map((row) => row.text),
      ];
    } else {
      while (start < end && rows[start]?.part !== 'heading') start++;
      visible = rows.slice(start, end).map((row) => row.text);
    }
  } else visible = rows.slice(start, end).map((row) => row.text);
  while (visible.length < room) visible.push('');
  return visible;
}
