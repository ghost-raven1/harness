import ora from 'ora';
import color from 'picocolors';
import { terminalText } from './screen.js';
import { fitLine } from './terminal-layout.js';

/** Индикатор описывает известное действие; проценты без измеримого объёма не вычисляются. */
export interface WorkIndicator {
  kind: 'busy' | 'waiting' | 'error';
  label: string;
  since?: string;
}

const frames = ora({ isSilent: true }).spinner.frames;

/** Показывает длительность текущей операции, если её начало известно из журнала. */
function elapsed(since: string | undefined, now: number): string {
  const started = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Встраивает кадр Ora в общую перерисовку, не создавая второго владельца терминала. */
export function workLine(work: WorkIndicator | undefined, width: number, now = Date.now()): string {
  if (!work) return '';
  const symbol =
    work.kind === 'busy'
      ? frames[Math.floor(now / 250) % frames.length]!
      : work.kind === 'waiting'
        ? 'Ⅱ'
        : '!';
  const duration = work.kind === 'busy' ? elapsed(work.since, now) : '';
  const suffix = duration ? ' · ' + duration : '';
  const line =
    symbol +
    ' ' +
    fitLine(terminalText(work.label).replace(/\s+/g, ' '), Math.max(1, width - suffix.length - 2)) +
    suffix;
  return work.kind === 'busy'
    ? color.cyan(line)
    : work.kind === 'error'
      ? color.red(line)
      : color.yellow(line);
}

/** Анимация не опрашивает сервис и освобождается вместе с экраном. */
export function animateWork(active: () => boolean, render: () => void): () => void {
  const timer = setInterval(() => {
    if (active()) render();
  }, 250);
  return () => clearInterval(timer);
}
