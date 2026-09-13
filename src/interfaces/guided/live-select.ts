import * as prompts from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import { createLogUpdate } from 'log-update';
import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import { brandName } from '../branding.js';
import { note } from '../ui.js';
import { page, terminalText } from './screen.js';
import { boxLine, rule, menuWidth, menuSummaryRoom } from './terminal-layout.js';
import { startRefresh } from './live-refresh.js';

export interface LiveOption<T> {
  value: T;
  label: string;
  hint?: string;
}
export interface LiveMenu<T> {
  message: string;
  options: LiveOption<T>[];
  summary?: string;
  summaryTitle?: string;
  summaryRows?: number;
}
export interface LiveSelectOptions<T> {
  title: string;
  initialValue?: T;
  load: () => Promise<LiveMenu<T>>;
  /** Передаёт окончательную ошибку владельцу экрана; остальные ошибки допускают переподключение. */
  exitOnError?: (error: unknown) => boolean;
}

/** Выделение привязано к записи, а исчезнувший пункт нельзя случайно подтвердить. */
export class MenuSelection<T> {
  value: T | undefined;
  constructor(initial?: T) {
    this.value = initial;
  }
  /** Сохраняет выбор по значению; исчезнувший пункт не заменяется без действия пользователя. */
  update(options: LiveOption<T>[], initial = false): void {
    if (!options.some((item) => item.value === this.value))
      this.value = initial ? options[0]?.value : undefined;
  }
  /** Перемещает выбор циклически по актуальному набору пунктов. */
  move(options: LiveOption<T>[], delta: number): void {
    const index = options.findIndex((item) => item.value === this.value);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : options.length - 1
        : (index + delta + options.length) % options.length;
    this.value = options[next]?.value;
  }
}

/** Живая карточка ограничена размером терминала; клавиши остаются в нижней строке. */
export function menuFrame<T>(
  title: string,
  menu: LiveMenu<T>,
  selection: T | undefined,
  width: number,
  height: number,
  error = '',
): string {
  width = menuWidth(width + 1);
  if (width < 35 || height < 14)
    return ['[H] ' + brandName, 'Увеличьте окно терминала', 'Esc — назад']
      .slice(0, Math.max(1, height - 1))
      .map((line) => boxLine(line, width))
      .join('\n');
  const wrap = (text: string): string[] =>
    wrapAnsi(terminalText(text), width - 4, { hard: true }).split('\n');
  const heading = [
    rule(width, '[H] ' + brandName, 'top'),
    boxLine(color.bold(terminalText(title)), width),
  ];
  const summary = menu.summary ? wrap(menu.summary) : [];
  const summaryRoom = menuSummaryRoom(height, menu.summaryRows);
  if (summary.length) {
    heading.push(rule(width, menu.summaryTitle));
    const visible = summary.slice(0, summaryRoom);
    if (summary.length > summaryRoom && visible.length) visible[visible.length - 1] += '…';
    heading.push(...visible.map((line) => boxLine(line, width)));
  }
  heading.push(rule(width, menu.message));
  const footer = [
    rule(width, error ? 'Нет связи · повторяем подключение' : ''),
    boxLine('↑↓ — выбор · Enter — открыть · Esc — назад', width),
    rule(width, '', 'bottom'),
  ];
  const room = Math.max(1, height - heading.length - footer.length - 2);
  const index = menu.options.findIndex((item) => item.value === selection);
  const rows = menu.options.map((item) => {
    const active = item.value === selection;
    const text = terminalText(item.label + (item.hint ? ' · ' + item.hint : ''));
    return wrapAnsi(text, width - 6, { hard: true })
      .split('\n')
      .map((line, lineIndex) => {
        const value = (lineIndex ? '  ' : active ? '● ' : '○ ') + line;
        return boxLine(active ? color.cyan(color.bold(value)) : value, width);
      });
  });
  const allRows = rows.flat();
  const selectedRow = rows.slice(0, Math.max(0, index)).reduce((sum, item) => sum + item.length, 0);
  const selectedHeight = rows[index]?.length ?? 1;
  const start = Math.max(
    0,
    Math.min(
      selectedRow - Math.max(0, Math.floor((room - selectedHeight) / 2)),
      allRows.length - room,
    ),
  );
  const items = allRows.slice(start, start + room);
  while (items.length < room) items.push(boxLine('', width));
  return [
    ...heading,
    ...items,
    boxLine(
      index < 0
        ? 'Список изменился · выберите пункт'
        : allRows.length > room
          ? `${index + 1} / ${menu.options.length} · ещё пункты ↑↓`
          : '',
      width,
    ),
    ...footer,
  ].join('\n');
}

/** Перечитывает данные, сохраняя выбор; закрытие отменяет дальнейшую перерисовку. */
export async function liveSelect<T extends string | number>(
  options: LiveSelectOptions<T>,
): Promise<T | symbol> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb';
  let menu: LiveMenu<T> = { message: 'Подключение к данным', options: [] };
  let error = '';
  try {
    menu = await options.load();
  } catch (problem) {
    if (!interactive || options.exitOnError?.(problem)) throw problem;
    error = 'disconnected';
  }
  if (!interactive) {
    page(options.title);
    if (menu.summary) note(menu.summary, menu.summaryTitle ?? options.title);
    return prompts.select({
      message: menu.message,
      options: menu.options as prompts.Option<T>[],
      initialValue: options.initialValue,
      maxItems: 6,
    });
  }
  page('', false);
  const draw = createLogUpdate(process.stdout);
  const selection = new MenuSelection(options.initialValue);
  selection.update(menu.options, true);
  let initial = !menu.options.length;
  const render = (): void =>
    draw(
      menuFrame(
        options.title,
        menu,
        selection.value,
        Math.max(1, (process.stdout.columns || 80) - 1),
        process.stdout.rows || 24,
        error,
      ),
    );
  let stop = (): void => undefined;
  const raw = process.stdin.isRaw,
    wasFlowing = process.stdin.readableFlowing === true;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on('resize', render);
  let handle!: (_text: string, key: Key) => void;
  try {
    return await new Promise<T | symbol>((resolve, reject) => {
      handle = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c'))
          return resolve(Symbol('cancel'));
        if ((process.stdout.columns || 80) < 36 || (process.stdout.rows || 24) < 14) return;
        if (key.name === 'up') selection.move(menu.options, -1);
        if (key.name === 'down') selection.move(menu.options, 1);
        if (key.name === 'home') selection.value = menu.options[0]?.value;
        if (key.name === 'end') selection.value = menu.options.at(-1)?.value;
        if (
          key.name === 'return' &&
          selection.value !== undefined &&
          (!error || selection.value === 'back' || selection.value === 'exit')
        )
          return resolve(selection.value);
        render();
      };
      process.stdin.on('keypress', handle);
      render();
      stop = startRefresh(
        options.load,
        (next) => {
          menu = next;
          selection.update(menu.options, initial);
          initial = false;
          error = '';
          render();
        },
        (problem) => {
          if (options.exitOnError?.(problem)) return reject(problem);
          error = 'disconnected';
          render();
        },
      );
    });
  } finally {
    stop();
    process.stdin.off('keypress', handle);
    process.stdout.off('resize', render);
    process.stdin.setRawMode(raw);
    if (!wasFlowing) process.stdin.pause();
    draw.done();
  }
}
