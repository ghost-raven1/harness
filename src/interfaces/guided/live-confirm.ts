import * as prompts from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import { createLogUpdate } from 'log-update';
import wrapAnsi from 'wrap-ansi';
import { brandName } from '../branding.js';
import { page, terminalText } from './screen.js';
import { boxLine, rule, fitLine } from './terminal-layout.js';
import { startRefresh } from './live-refresh.js';

interface ConfirmationState {
  available: boolean;
  detail: string;
}
interface LiveConfirmation {
  title: string;
  message: string;
  body: string;
  active?: string;
  inactive?: string;
  bodyTitle?: string;
  load: () => Promise<ConfirmationState>;
}

/** Аргументы закреплены; обновляется только актуальность ожидающего разрешения. */
export async function liveConfirm(
  options: LiveConfirmation,
): Promise<boolean | symbol | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === 'dumb') {
    process.stdout.write(
      wrapAnsi(
        terminalText(options.title + '\n' + options.body),
        Math.max(1, (process.stdout.columns || 80) - 1),
        { hard: true },
      ) + '\n',
    );
    return prompts.confirm({
      message: options.message,
      initialValue: false,
      active: options.active ?? 'Да',
      inactive: options.inactive ?? 'Нет',
    });
  }
  let state = await options.load();
  let allow = false,
    offset = 0,
    room = 1,
    maximum = 0,
    error = false;
  page('', false);
  const draw = createLogUpdate(process.stdout);
  const render = (): void => {
    const width = Math.max(5, (process.stdout.columns || 80) - 1);
    const height = process.stdout.rows || 24;
    if (width < 40 || height < 18) {
      draw(
        ['[H] ' + brandName, 'Расширьте окно до 40×18', 'Esc — назад']
          .slice(0, Math.max(1, height - 1))
          .map((line) => fitLine(line, width))
          .join('\n'),
      );
      return;
    }
    const lines = wrapAnsi(terminalText(options.body), Math.max(1, width - 4), {
      hard: true,
      trim: false,
    }).split('\n');
    const question = wrapAnsi(options.message, Math.max(1, width - 4), { hard: true }).split('\n');
    const header = [
      rule(width, '[H] ' + brandName, 'top'),
      boxLine(options.title, width),
      rule(width, options.bodyTitle ?? 'Подробности'),
    ];
    const footer = [
      rule(width, error ? 'Нет связи · повторяем подключение' : state.detail),
      ...question.map((line) => boxLine(line, width)),
      boxLine(
        state.available
          ? (allow ? '● ' : '○ ') +
              (options.active ?? 'Да') +
              '    ' +
              (allow ? '○ ' : '● ') +
              (options.inactive ?? 'Нет')
          : 'Решение больше не требуется',
        width,
      ),
      boxLine('←→ — выбор · Enter — подтвердить', width),
      boxLine('Esc — назад · PgUp/PgDn — прокрутка', width),
      rule(width, '', 'bottom'),
    ];
    room = Math.max(1, height - header.length - footer.length - 1);
    maximum = Math.max(0, lines.length - room);
    offset = Math.min(Math.max(0, offset), maximum);
    const body = lines.slice(offset, offset + room);
    while (body.length < room) body.push('');
    draw([...header, ...body.map((line) => boxLine(line, width)), ...footer].join('\n'));
  };
  const stop = startRefresh(
    options.load,
    (next) => {
      state = next;
      error = false;
      render();
    },
    () => {
      error = true;
      render();
    },
  );
  const raw = process.stdin.isRaw,
    wasFlowing = process.stdin.readableFlowing === true;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.on('resize', render);
  let handle!: (_text: string, key: Key) => void;
  try {
    return await new Promise((resolve) => {
      handle = (_text, key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c'))
          return resolve(Symbol('cancel'));
        if ((process.stdout.columns || 80) < 41 || (process.stdout.rows || 24) < 18) return;
        if (['left', 'right', 'up', 'down', 'space'].includes(key.name ?? '')) allow = !allow;
        if (key.name === 'pageup') offset -= room;
        if (key.name === 'pagedown') offset += room;
        if (key.name === 'home') offset = 0;
        if (key.name === 'end') offset = maximum;
        if (key.name === 'return' && !error) return resolve(state.available ? allow : undefined);
        render();
      };
      process.stdin.on('keypress', handle);
      render();
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
