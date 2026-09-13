import * as prompts from '@clack/prompts';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { selected } from '../ui.js';
import { liveSelect } from './live-select.js';
import { page } from './screen.js';

/** Приводит вставленный из терминала путь к форме, пригодной для выбора папки. */
export function pastedPath(value: string): string {
  const unquoted = value.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (unquoted === '~') return homedir();
  return resolve(unquoted.startsWith('~/') ? join(homedir(), unquoted.slice(2)) : unquoted);
}

/** Позволяет выбирать папки стрелками; длинный путь можно вставить из проводника. */
export async function chooseFolder(start = homedir()): Promise<string> {
  let current = start;
  while (true) {
    const choice = selected(
      await liveSelect({
        title: 'Выбор папки',
        load: async () => {
          let folders: string[] = [],
            problem = '';
          try {
            folders = (await readdir(current, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
              .map((entry) => entry.name)
              .sort((a, b) => a.localeCompare(b));
          } catch {
            problem = 'Не удалось открыть папку. Можно вставить другой путь.';
          }
          return {
            message: 'Папка для работы: ' + current,
            summary: problem || current,
            options: [
              { value: 'use', label: 'Выбрать эту папку', hint: basename(current) || current },
              { value: 'path', label: 'Вставить путь к папке' },
              ...(dirname(current) !== current
                ? [{ value: 'parent', label: '↑ На папку выше' }]
                : []),
              ...folders.map((name) => ({ value: 'folder:' + name, label: name + '/' })),
            ],
          };
        },
      }),
    );
    if (choice === 'parent') current = dirname(current);
    else if (choice === 'path') {
      page('Путь к рабочей папке');
      const value = selected(
        await prompts.text({
          message: 'Вставьте полный путь к существующей папке',
          initialValue: current,
          validate: (value) => (value.trim() ? undefined : 'Нужен путь к папке'),
        }),
      );
      const next = pastedPath(value);
      try {
        if (!(await stat(next)).isDirectory()) throw new Error();
        current = await realpath(next);
      } catch {
        prompts.log.warn('Папка не найдена. Проверьте путь и попробуйте ещё раз.');
      }
    } else if (choice === 'use') {
      try {
        if (!(await stat(current)).isDirectory()) throw new Error();
        return await realpath(current);
      } catch {
        prompts.log.warn('Нужна существующая доступная папка.');
      }
    } else current = join(current, choice.slice('folder:'.length));
  }
}
