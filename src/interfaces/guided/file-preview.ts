import * as prompts from '@clack/prompts';
import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import type { CliContext, StatusView } from '../types.js';
import { note, selected } from '../ui.js';
import { page, backFromPage, terminalText } from './screen.js';
import { liveSelect } from './live-select.js';
import { liveConfirm } from './live-confirm.js';
export interface FilePreview {
  path: string;
  diff: string;
  previewToken: string;
  next?: number;
}

/** Разбивает diff по видимым строкам, оставляя место для заголовка и подтверждения. */
export function previewPages(diff: string, columns: number, rows: number): string[] {
  const lines = wrapAnsi(terminalText(diff), Math.max(1, columns - 6), {
    hard: true,
    trim: false,
  }).split('\n');
  const size = Math.max(1, rows - 17);
  const pages: string[] = [];
  for (let start = 0; start < lines.length; start += size)
    pages.push(lines.slice(start, start + size).join('\n'));
  return pages;
}

/** Позволяет дочитать большой diff до подтверждения; версия файла закрепляется первой страницей. */
export async function showFilePreview(
  load: (offset: number) => Promise<FilePreview>,
): Promise<string> {
  let offset = 0,
    token = '';
  while (true) {
    const preview = await load(offset);
    if (token && preview.previewToken !== token)
      throw new Error('Файл изменился во время просмотра. Откройте операцию заново.');
    token = preview.previewToken;
    const pages = process.stdout.isTTY
      ? previewPages(preview.diff, process.stdout.columns || 80, process.stdout.rows || 24)
      : [terminalText(preview.diff)];
    for (let index = 0; index < pages.length; index++) {
      page('Просмотр изменений');
      note(
        pages[index]!.split('\n')
          .map((line) =>
            line.startsWith('+')
              ? color.green(line)
              : line.startsWith('-')
                ? color.red(line)
                : line,
          )
          .join('\n'),
        'Изменения: ' + terminalText(preview.path),
      );
      if (index === pages.length - 1 && preview.next === undefined) return token;
      const action = selected(
        await prompts.select({
          message: 'Есть ещё изменения',
          options: [
            { value: 'next', label: 'Показать следующую часть' },
            { value: 'stop', label: 'Вернуться без разрешения' },
          ],
        }),
      );
      if (action === 'stop') throw new Error('INTERACTIVE_CANCEL');
    }
    if (preview.next === undefined) return token;
    offset = preview.next;
  }
}

/** Позволяет выбрать изменение и восстановить файл после проверки текущего содержимого. */
export async function restoreFile(context: CliContext, runId: string): Promise<void> {
  const changeId = selected(
    await liveSelect({
      title: 'Восстановление файла',
      load: async () => {
        const status = await context.request<StatusView>('runtime.status', { runId });
        const changes = status.deletedAt ? [] : (status.fileChanges ?? []);
        return {
          message: 'Какой файл вернуть к состоянию перед записью?',
          options: [
            ...changes
              .filter((item) => item.status === 'applied')
              .reverse()
              .map((item) => ({ value: item.id, label: item.path, hint: item.id.slice(0, 8) })),
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (changeId === 'back') return;
  const current = await context.request<StatusView>('runtime.status', { runId });
  if (
    current.deletedAt ||
    !current.fileChanges?.some((item) => item.id === changeId && item.status === 'applied')
  )
    throw new Error(
      'Изменение уже восстановлено или задача скрыта. Откройте список файлов заново.',
    );
  const previewParts: string[] = [];
  const previewToken = await showFilePreview(async (offset) => {
    const preview = await context.request<FilePreview>('files.previewRestore', {
      runId,
      changeId,
      offset,
    });
    previewParts.push(preview.diff);
    return preview;
  });
  const yes = selected(
    (await liveConfirm({
      title: 'Восстановление файла',
      message: 'Восстановить прежнее содержимое? Файл, созданный задачей, будет удалён.',
      body:
        'Файл: ' +
        current.fileChanges!.find((item) => item.id === changeId)!.path +
        '\n\n' +
        previewParts.join(''),
      active: 'Восстановить',
      inactive: 'Оставить',
      load: async () => {
        const current = await context.request<StatusView>('runtime.status', { runId });
        const available =
          !current.deletedAt &&
          !!current.fileChanges?.some((item) => item.id === changeId && item.status === 'applied');
        return {
          available,
          detail: available
            ? 'Изменение ещё доступно для восстановления'
            : 'Изменение восстановлено или задача скрыта',
        };
      },
    })) ?? false,
  );
  if (yes) {
    const current = await context.request<StatusView>('runtime.status', { runId });
    if (
      current.deletedAt ||
      !current.fileChanges?.some((item) => item.id === changeId && item.status === 'applied')
    )
      throw new Error('Состояние изменилось в другом окне. Откройте восстановление заново.');
    await context.request('files.restore', { runId, changeId, previewToken });
    page('Файл восстановлен');
    prompts.log.success('Исходное состояние файла восстановлено.');
    await backFromPage();
  }
}
