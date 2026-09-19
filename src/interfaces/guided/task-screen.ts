import { createLogUpdate } from 'log-update';
import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import { TaskFeed, type FeedTab } from './task-feed.js';
import { contentRows, contentWindow, type ContentRow } from './task-content.js';
import { taskGeometry, taskHeader, taskFooter, taskTabs } from './task-chrome.js';
import { boxLine, rule } from './terminal-layout.js';
export type ViewKey =
  | 'back'
  | 'cancel'
  | 'enter'
  | 'message'
  | 'tab'
  | 'up'
  | 'down'
  | 'page-up'
  | 'page-down'
  | 'end';

/** Разметка помещается в окно; информационные строки не вытесняют клавиши управления. */
export function taskFrame(
  feed: TaskFeed,
  width: number,
  height: number,
  tab: FeedTab,
  offset: number,
  lines = contentRows(feed, taskGeometry(width).content, tab),
  connectionLost = false,
  notice = '',
): string {
  const status = feed.status;
  const geometry = taskGeometry(width);
  const active =
    !status || (!status.deletedAt && ['running', 'awaiting_approval'].includes(status.status));
  if (width < 40 || height < 18)
    return wrapAnsi(
      'Расширьте окно до 40×18 для просмотра задачи.\nEsc — в меню · Enter — действия',
      Math.max(1, width - 1),
      { hard: true },
    )
      .split('\n')
      .slice(0, Math.max(1, height - 1))
      .join('\n');
  const header = taskHeader(status, geometry.width, height, tab);
  const writable =
    !!status &&
    !status.project &&
    !status.recoveryRequired &&
    !status.deletedAt &&
    ['running', 'awaiting_approval', 'paused'].includes(status.status);
  const footer = taskFooter(geometry.width, active && !status?.project, writable);
  if (notice)
    footer.unshift(
      ...wrapAnsi(notice, geometry.content, { hard: true, trim: false })
        .split('\n')
        .slice(0, 2)
        .map((line) => boxLine(line, geometry.width)),
    );
  const room = Math.max(1, height - header.length - footer.length - 3);
  const visible = contentWindow(lines, room, offset, geometry.content);
  const hint = connectionLost ? 'Нет связи · повторяем подключение' : '';
  return [
    ...header,
    rule(geometry.width, color.bold(taskTabs.find((item) => item.id === tab)!.title), 'top'),
    ...visible.map((line) => boxLine(line, geometry.width)),
    rule(geometry.width, color.dim(hint), 'bottom'),
    ...footer,
  ]
    .map((line) => geometry.margin + line)
    .join('\n');
}

/** log-update заменяет текущую область; при чтении истории новые события не сдвигают её. */
export class TaskScreen {
  readonly feed: TaskFeed;
  connectionLost = false;
  notice = '';
  private tab: FeedTab = 'all';
  private offset = 0;
  private closed = false;
  private revision = -1;
  private width = 0;
  private lines: ContentRow[] = [];
  private readonly draw =
    process.stdout.isTTY && process.env.TERM !== 'dumb'
      ? createLogUpdate(process.stdout)
      : undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(feed = new TaskFeed()) {
    this.feed = feed;
    this.timer = setInterval(() => this.render(), 250);
    process.stdout.on('resize', this.render);
  }
  /** Меняет вкладку или позицию чтения, оставляя действия задачи внешнему контроллеру. */
  key(key: ViewKey): void {
    if (key === 'tab') {
      this.tab =
        taskTabs[(taskTabs.findIndex((tab) => tab.id === this.tab) + 1) % taskTabs.length]!.id;
      this.offset = 0;
      this.revision = -1;
    }
    if (key === 'up' || key === 'page-up')
      this.offset = Math.min(
        Math.max(0, this.lines.length - 1),
        this.offset + (key === 'up' ? 1 : 10),
      );
    if (key === 'down' || key === 'page-down')
      this.offset = Math.max(0, this.offset - (key === 'down' ? 1 : 10));
    if (key === 'end') this.offset = 0;
    this.render();
  }
  /** Перерисовывает экран без сдвига выбранного фрагмента при поступлении новых событий. */
  render = (): void => {
    if (this.closed || !this.draw) return;
    const width = process.stdout.columns || 80;
    if (this.revision !== this.feed.revision || this.width !== width) {
      const lines = contentRows(this.feed, taskGeometry(width).content, this.tab);
      if (this.offset && this.width === width)
        this.offset = Math.max(0, this.offset + lines.length - this.lines.length);
      this.lines = lines;
      this.width = width;
      this.revision = this.feed.revision;
    }
    this.draw(
      taskFrame(
        this.feed,
        width,
        process.stdout.rows || 24,
        this.tab,
        this.offset,
        this.lines,
        this.connectionLost,
        this.notice,
      ),
    );
  };
  /** Освобождает таймер, обработчик размера и область перерисовки при уходе с экрана. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    process.stdout.off('resize', this.render);
    this.draw?.done();
  }
}
