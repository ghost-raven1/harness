import * as prompts from '@clack/prompts';
import { PassThrough } from 'node:stream';
import { emitKeypressEvents, type Key } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { createLogUpdate } from 'log-update';
import wrapAnsi from 'wrap-ansi';
import { boxLine, menuWidth, rule } from './terminal-layout.js';
import { terminalText, page } from './screen.js';
import { brandName } from '../branding.js';
import { TaskInputState, PasteDecoder } from './task-input-state.js';
import { taskTextLimit } from '../../sessions/drafts.js';
import { workspaceLine } from './task-layout.js';
import { startRefresh } from './live-refresh.js';
import { isMissingResource } from '../../shared/resource-errors.js';

export interface TaskInputOptions {
  message: string;
  initialValue?: string;
  workspace?: string;
  description?(): string;
  save(text: string): Promise<void>;
  refresh?(): Promise<unknown>;
}

/** Ввод задачи использует явную отправку Ctrl+S, включая многострочную вставку из буфера. */
export async function readTaskInput(options: TaskInputOptions): Promise<string | symbol> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    const value = await prompts.text({
      message: options.message,
      initialValue: options.initialValue,
      validate: (text) =>
        !text.trim()
          ? 'Опишите задачу своими словами'
          : text.length > taskTextLimit
            ? 'Не больше 100 000 символов'
            : undefined,
    });
    if (typeof value === 'string') await options.save(value);
    return value;
  }
  page('', false);
  const state = new TaskInputState(options.initialValue);
  const draw = createLogUpdate(process.stdout);
  const stream = new PassThrough();
  emitKeypressEvents(stream);
  const decoder = new StringDecoder('utf8');
  let saving = false,
    saved = true,
    closing = false,
    discarding = false;
  let saveTimer: NodeJS.Timeout | undefined, escapeTimer: NodeJS.Timeout | undefined;
  let tail = Promise.resolve();
  let stopRefresh = () => undefined as void;
  let missing = (_error: unknown) => undefined as void;
  const render = (): void => {
    const width = menuWidth(process.stdout.columns || 80),
      height = process.stdout.rows || 24;
    const inner = Math.max(1, width - 4);
    const cursorText = (
      state.text.slice(0, state.cursor) +
      '█' +
      state.text.slice(state.cursor)
    ).replace(/\t/g, '    ');
    const lines = wrapAnsi(terminalText(cursorText), inner, { hard: true, trim: false }).split(
      '\n',
    );
    const cursorLine =
      wrapAnsi(
        terminalText((state.text.slice(0, state.cursor) + '█').replace(/\t/g, '    ')),
        inner,
        {
          hard: true,
          trim: false,
        },
      ).split('\n').length - 1;
    const room = Math.max(1, height - (options.workspace ? 12 : 10));
    const start = Math.max(0, cursorLine - room + 1);
    const visible = lines.slice(start, start + room);
    while (visible.length < room) visible.push('');
    const foot =
      state.error ||
      (saving ? 'Сохраняю черновик…' : saved ? 'Черновик сохранён' : 'Изменения ещё не сохранены');
    draw(
      [
        rule(width, '[H] ' + brandName, 'top'),
        boxLine(options.message, width),
        ...(options.workspace
          ? [
              rule(width, 'Рабочая папка этой задачи'),
              boxLine(workspaceLine(options.workspace, inner), width),
            ]
          : []),
        rule(width, options.description?.() ?? 'Опишите задачу своими словами'),
        ...visible.map((line) => boxLine(line, width)),
        rule(width, `${state.text.length} / ${taskTextLimit} символов`),
        boxLine(discarding ? 'Выйти без последних изменений?' : foot, width),
        boxLine(
          discarding
            ? 'Ранее сохранённый черновик останется.'
            : 'Enter — новая строка · Ctrl+S — отправить',
          width,
        ),
        boxLine(discarding ? 'Y / Д — выйти · Esc — остаться' : 'Esc — сохранить и выйти', width),
        rule(width, '', 'bottom'),
      ].join('\n'),
    );
  };
  const persist = (): Promise<void> => {
    clearTimeout(saveTimer);
    const text = state.text;
    saving = true;
    render();
    const next = tail.then(() => options.save(text));
    tail = next.catch(() => undefined);
    return next
      .then(
        () => {
          saved = state.text === text;
        },
        (error) => {
          if (isMissingResource(error, 'draft')) missing(error);
          state.error = taskInputSaveMessage(error);
          throw error;
        },
      )
      .finally(() => {
        saving = false;
        render();
      });
  };
  const changed = (): void => {
    saved = false;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void persist().catch(() => undefined);
    }, 300);
    render();
  };
  const paste = new PasteDecoder(
    (text) => stream.write(text),
    (text) => {
      if (closing) return;
      if (state.insert(text)) changed();
      else render();
    },
  );
  const raw = process.stdin.isRaw,
    flowing = process.stdin.readableFlowing === true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\u001b[?2004h');
  let data!: (chunk: Buffer | string) => void, keypress!: (text: string, key: Key) => void;
  try {
    return await new Promise<string | symbol>((resolve, reject) => {
      missing = (error) => {
        closing = true;
        state.text = '';
        state.cursor = 0;
        state.error = 'Черновик удалён в другом окне';
        render();
        reject(error);
      };
      const finish = async (cancel: boolean): Promise<void> => {
        if (closing) return;
        if (!cancel && !state.text.trim()) {
          state.error = 'Опишите задачу своими словами';
          render();
          return;
        }
        closing = true;
        try {
          await persist();
          resolve(cancel ? Symbol('saved-draft') : state.text);
        } catch {
          closing = false;
          if (cancel) {
            discarding = true;
            render();
          }
        }
      };
      keypress = (text, key) => {
        if (discarding) {
          if (key.name === 'y' || text?.toLowerCase() === 'д') resolve(Symbol('discard-unsaved'));
          else if (key.name === 'escape') {
            discarding = false;
            render();
          }
          return;
        }
        if (closing) return;
        if (key.ctrl && key.name === 's') {
          void finish(false);
          return;
        }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          void finish(true);
          return;
        }
        if (key.name === 'left') state.move(-1);
        else if (key.name === 'right') state.move(1);
        else if (key.name === 'up') state.vertical(-1);
        else if (key.name === 'down') state.vertical(1);
        else if (key.name === 'home' || (key.ctrl && key.name === 'a')) state.edge(false);
        else if (key.name === 'end' || (key.ctrl && key.name === 'e')) state.edge(true);
        else if (key.name === 'backspace' || key.name === 'delete') {
          state.erase(key.name === 'backspace');
          changed();
          return;
        } else if (key.name === 'return' || key.name === 'enter') {
          if (state.insert('\n')) changed();
          return;
        } else if (text && !key.ctrl && !key.meta && !key.sequence?.startsWith('\u001b')) {
          if (state.insert(text)) changed();
          else render();
          return;
        }
        render();
      };
      stream.on('keypress', keypress);
      data = (chunk) => {
        clearTimeout(escapeTimer);
        paste.write(typeof chunk === 'string' ? chunk : decoder.write(chunk));
        escapeTimer = setTimeout(() => paste.flushEscape(), 80);
      };
      process.stdin.on('data', data);
      process.stdout.on('resize', render);
      if (options.refresh)
        stopRefresh = startRefresh(options.refresh, render, (error) => {
          if (isMissingResource(error, 'draft')) missing(error);
        });
      render();
    });
  } finally {
    stopRefresh();
    clearTimeout(saveTimer);
    clearTimeout(escapeTimer);
    process.stdin.off('data', data);
    stream.off('keypress', keypress);
    stream.destroy();
    process.stdout.off('resize', render);
    process.stdout.write('\u001b[?2004l');
    process.stdin.setRawMode(raw);
    if (!flowing) process.stdin.pause();
    await tail;
    draw.done();
  }
}

/** Короткая причина помещается в узкий терминал и не раскрывает сырой ответ транспорта. */
export function taskInputSaveMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /Local service|IPC response|ECONNREFUSED|ECONNRESET|EPIPE|ENOTCONN|socket.*closed/i.test(detail)
  )
    return 'Нет связи. Текст остаётся в этом окне.';
  if (/ENOSPC|EFBIG/i.test(detail)) return 'Не хватает места для черновика.';
  if (/EACCES|EPERM|EROFS/i.test(detail)) return 'Нет доступа к папке черновиков.';
  if (isMissingResource(error, 'draft')) return 'Черновик удалён в другом окне.';
  if (/Черновик изменён/.test(detail)) return 'Черновик изменён в другом окне.';
  return 'Не удалось сохранить. Текст в этом окне.';
}
