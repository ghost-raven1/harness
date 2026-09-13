import { stripVTControlCharacters } from 'node:util';
import { showLogo, renderLogo } from '../branding.js';
import * as prompts from '@clack/prompts';

let active = false;
/** Вывод модели не может управлять курсором, заголовком окна или буфером обмена терминала. */
export function terminalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
/** Рабочий стол занимает отдельный буфер; выход восстанавливает исходный терминал. */
export function enterDesktopScreen(): () => void {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return () => undefined;
  active = true;
  process.stdout.write('\u001b[?1049h');
  return () => {
    if (!active) return;
    active = false;
    process.stdout.write('\u001b[?25h\u001b[?1049l');
  };
}
/** Новая страница заменяет предыдущую; JSON и перенаправленный вывод остаются обычными потоками. */
export function page(title: string, logo = true): void {
  if (!active) return;
  commandPage(title, logo);
}
/** Отдельные команды с мастером тоже сменяют страницы, сохраняя итог в обычном терминале. */
export function commandPage(title: string, logo = true): void {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  process.stdout.write('\u001b[2J\u001b[H');
  if (logo) {
    if ((process.stdout.rows || 24) < 32)
      process.stdout.write(renderLogo(process.stdout.columns || 80, true) + '\n\n');
    else showLogo();
  }
  if (title) process.stdout.write(terminalText(title) + '\n\n');
}
/** Удерживает информационную страницу до возврата; в автоматических проверках не запрашивает ввод. */
export async function backFromPage(): Promise<void> {
  if (!active) return;
  await prompts.select({ message: 'Продолжить', options: [{ value: 'back', label: '← Назад' }] });
}
