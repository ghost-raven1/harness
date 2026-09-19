import { emitKeypressEvents, type Key } from 'node:readline';
import { createLogUpdate } from 'log-update';
import wrapAnsi from 'wrap-ansi';
import color from 'picocolors';
import { brandName } from '../branding.js';
import { page, terminalText } from './screen.js';
import { boxLine, rule, menuWidth } from './terminal-layout.js';
import { startRefresh } from './live-refresh.js';
import { explainError } from './errors.js';
import { animateWork, workLine, type WorkIndicator } from './work-indicator.js';

export interface TextTab {
  id: string;
  label: string;
  text: string;
}
export interface ReaderOptions {
  activity?: WorkIndicator;
  subtitle?: string;
  notice?: string;
  actionLabel?: string;
  load?: () => Promise<ReaderSnapshot>;
  exitOnError?: (error: unknown) => boolean;
}

export interface ReaderSnapshot {
  activity?: WorkIndicator;
  tabs: TextTab[];
  subtitle?: string;
  notice?: string;
  actionLabel?: string;
}

/** Обновление данных сохраняет выбранный раздел и место чтения; End следует за концом. */
export class ReaderState {
  private snapshot: ReaderSnapshot;
  private tabId: string;
  private offset = 0;
  private maximum = 0;
  private pageSize = 1;
  private followEnd = false;
  private error?: string;

  constructor(snapshot: ReaderSnapshot) {
    this.snapshot = snapshot;
    this.tabId = snapshot.tabs[0]?.id ?? '';
  }

  /** Обновляет текст, сохраняя существующую вкладку и положение чтения. */
  update(snapshot: ReaderSnapshot): void {
    if (!snapshot.tabs.some((tab) => tab.id === this.tabId)) {
      this.tabId = snapshot.tabs[0]?.id ?? '';
      this.offset = 0;
      this.followEnd = false;
    }
    this.snapshot = snapshot;
    this.error = undefined;
  }

  /** Сохраняет читаемую ошибку обновления поверх последнего доступного текста. */
  failed(error: unknown): void {
    this.error = 'Обновление: ' + explainError(error);
  }

  /** Возвращает действие текущего снимка, включая переход к частям большого ответа. */
  get actionLabel(): string | undefined {
    return this.snapshot.actionLabel;
  }

  /** Ошибка обновления останавливает анимацию устаревшего состояния. */
  get working(): boolean {
    return !this.error && this.snapshot.activity?.kind === 'busy';
  }

  /** Переключает вкладки и прокрутку с учётом режима следования за концом текста. */
  key(key: Pick<Key, 'name' | 'shift'>): void {
    const tabs = this.snapshot.tabs;
    if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
      const direction = key.name === 'left' || key.shift ? -1 : 1;
      const current = Math.max(
        0,
        tabs.findIndex((tab) => tab.id === this.tabId),
      );
      this.tabId = tabs[(current + direction + tabs.length) % Math.max(1, tabs.length)]?.id ?? '';
      this.offset = 0;
      this.followEnd = false;
    }
    if (['up', 'down', 'pageup', 'pagedown', 'home'].includes(key.name ?? ''))
      this.followEnd = false;
    if (key.name === 'up') this.offset--;
    if (key.name === 'down') this.offset++;
    if (key.name === 'pageup') this.offset -= this.pageSize;
    if (key.name === 'pagedown') this.offset += this.pageSize;
    if (key.name === 'home') this.offset = 0;
    if (key.name === 'end') {
      this.followEnd = true;
      this.offset = this.maximum;
    }
    this.offset = Math.max(0, Math.min(this.offset, this.maximum));
  }

  /** Пересчитывает предел прокрутки после изменения текста или размеров окна. */
  frame(title: string, width: number, height: number, options: ReaderOptions = {}): string {
    const { tabs, subtitle, notice } = this.snapshot;
    const tab = Math.max(
      0,
      tabs.findIndex((item) => item.id === this.tabId),
    );
    const view = {
      ...options,
      activity: this.error ? undefined : this.snapshot.activity,
      subtitle,
      notice: this.error ?? notice,
      actionLabel: this.actionLabel ?? options.actionLabel,
    };
    const first = readerFrame(title, tabs, tab, this.offset, width, height, view);
    this.maximum = first.maximum;
    this.pageSize = first.pageSize;
    const next = this.followEnd ? first.maximum : Math.min(this.offset, first.maximum);
    if (next === this.offset) return first.frame;
    this.offset = next;
    return readerFrame(title, tabs, tab, this.offset, width, height, view).frame;
  }
}

/** Полный текст переносится по ширине, а управление всегда остаётся в окне. */
export function readerFrame(
  title: string,
  tabs: TextTab[],
  tab: number,
  offset: number,
  width: number,
  height: number,
  options: ReaderOptions = {},
): { frame: string; maximum: number; pageSize: number } {
  width = menuWidth(width + 1);
  const bodyWidth = Math.max(1, width - 4);
  const lines = wrapAnsi(
    terminalText(tabs[tab]?.text || 'Здесь пока нет записей.').replace(/\t/g, '    '),
    bodyWidth,
    { hard: true, trim: false },
  ).split('\n');
  const header = [
    rule(width, '[H] ' + brandName, 'top'),
    boxLine(color.bold(terminalText(title)), width),
    ...(options.subtitle ? [boxLine(terminalText(options.subtitle), width)] : []),
    rule(width, workLine(options.activity, width - 4)),
    boxLine(
      tabs
        .map((item, index) =>
          index === tab
            ? color.cyan('[' + terminalText(item.label) + ']')
            : terminalText(item.label),
        )
        .join('  '),
      width,
    ),
    ...(options.notice ? [boxLine(terminalText(options.notice), width)] : []),
  ];
  const footer = [
    boxLine('↑↓/PgUp/PgDn — прокрутка · Home/End', width),
    boxLine('Tab / ←→ — раздел · Esc — назад', width),
    ...(options.actionLabel ? [boxLine('Enter — ' + options.actionLabel, width)] : []),
    rule(width, '', 'bottom'),
  ];
  const pageSize = Math.max(1, height - header.length - footer.length - 2);
  const maximum = Math.max(0, lines.length - pageSize);
  const start = Math.min(Math.max(0, offset), maximum);
  const body = lines.slice(start, start + pageSize);
  while (body.length < pageSize) body.push('');
  const position =
    'Строки ' +
    (start + 1) +
    '–' +
    Math.min(start + pageSize, lines.length) +
    ' из ' +
    lines.length;
  return {
    frame: [
      ...header,
      ...body.map((line) => boxLine(line, width)),
      rule(width, position),
      ...footer,
    ]
      .slice(0, Math.max(1, height - 1))
      .join('\n'),
    maximum,
    pageSize,
  };
}

/** Просмотр не выполняет действий: Enter только возвращает управление меню владельца. */
export async function readText(
  title: string,
  tabs: TextTab[],
  options: ReaderOptions = {},
): Promise<'back' | 'action'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    process.stdout.write(
      terminalText(title) +
        '\n' +
        tabs.map((tab) => terminalText(tab.label) + '\n' + terminalText(tab.text)).join('\n\n') +
        '\n',
    );
    return 'back';
  }
  page('', false);
  const draw = createLogUpdate(process.stdout);
  const raw = process.stdin.isRaw,
    wasFlowing = process.stdin.readableFlowing === true;
  const state = new ReaderState({
    tabs,
    subtitle: options.subtitle,
    notice: options.notice,
    activity: options.activity,
  });
  const render = (): void => {
    draw(
      state.frame(
        title,
        Math.max(1, (process.stdout.columns || 80) - 1),
        process.stdout.rows || 24,
        options,
      ),
    );
  };
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on('resize', render);
  let handle!: (_text: string, key: Key) => void;
  let stopRefresh = (): void => undefined;
  const stopAnimation = animateWork(() => state.working, render);
  try {
    return await new Promise<'back' | 'action'>((resolve, reject) => {
      handle = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return resolve('back');
        if (key.name === 'return' && (state.actionLabel ?? options.actionLabel))
          return resolve('action');
        state.key(key);
        render();
      };
      process.stdin.on('keypress', handle);
      render();
      if (options.load)
        stopRefresh = startRefresh(
          options.load,
          (snapshot) => {
            state.update(snapshot);
            render();
          },
          (error) => {
            if (options.exitOnError?.(error)) return reject(error);
            state.failed(error);
            render();
          },
        );
    });
  } finally {
    stopRefresh();
    stopAnimation();
    process.stdin.off('keypress', handle);
    process.stdout.off('resize', render);
    process.stdin.setRawMode(raw);
    if (!wasFlowing) process.stdin.pause();
    draw.done();
  }
}
