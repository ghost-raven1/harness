import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import { renderLogo } from '../branding.js';
import type { DesktopService, SessionKeys } from './service.js';

export type DesktopConnection = 'unstarted' | 'owned' | 'attached';
type FarewellState = DesktopConnection | 'failed';

const messages: Record<FarewellState, { title: string; detail: string }> = {
  owned: {
    title: 'До следующей задачи!',
    detail: 'История сохранена. Сервис остановлен.',
  },
  attached: {
    title: 'До следующей задачи!',
    detail: 'Вы отключились. Сервис продолжает работать в своём окне.',
  },
  unstarted: {
    title: 'Настройка отложена',
    detail: 'Вернуться можно при следующем запуске.',
  },
  failed: {
    title: 'Не удалось завершить работу',
    detail: 'Подробности ошибки — ниже.',
  },
};

/** Компактное прощание остаётся в обычном терминале после закрытия рабочего стола. */
export function renderFarewell(state: FarewellState, columns: number, ascii = false): string {
  const width = Math.max(1, columns);
  const { title, detail } = messages[state];
  const heading = state === 'failed' ? color.yellow(title) : color.bold(title);
  return [
    renderLogo(width, true),
    color.dim((ascii ? '-' : '─').repeat(Math.min(width, 42))),
    wrapAnsi(heading, width, { hard: true }),
    wrapAnsi(color.dim(detail), width, { hard: true }),
  ].join('\n');
}

/** Подтверждает завершение только после закрытия сервиса и восстановления терминала. */
export async function closeDesktop(
  host: Pick<DesktopService, 'close'>,
  keys: Pick<SessionKeys, 'clear'>,
  leaveScreen: () => void,
  connection: DesktopConnection,
): Promise<void> {
  let failed = false;
  let failure: unknown;
  try {
    await host.close();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    keys.clear();
    // Открытый поток клавиатуры не должен удерживать отключившееся окно CLI.
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.stdin.pause();
    leaveScreen();
  }
  if (process.stdout.isTTY) {
    const state = failed ? 'failed' : connection;
    process.stdout.write(
      '\n' +
        renderFarewell(state, process.stdout.columns || 80, process.env.TERM === 'dumb') +
        '\n\n',
    );
  }
  if (failed) throw failure;
}
