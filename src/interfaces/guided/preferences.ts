import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../../sessions/files.js';
import { privateDirectory } from '../local-channel.js';

const schema = z
  .object({
    configFile: z.string().min(1),
    workspace: z.string().min(1),
    profile: z.string().min(1),
  })
  .strict();
export type Preferences = z.infer<typeof schema>;

/** Сохраняет только выбор пользователя; ключи и ответы моделей сюда не попадают. */
export async function savePreferences(directory: string, value: Preferences): Promise<void> {
  await privateDirectory(directory);
  await atomicJson(join(directory, 'desktop.json'), schema.parse(value));
  const recent = await recentProjects(directory);
  await atomicJson(
    join(directory, 'desktop-projects.json'),
    [
      value,
      ...recent.filter((p) => p.configFile !== value.configFile || p.workspace !== value.workspace),
    ].slice(0, 20),
  );
}

export async function readPreferences(directory: string): Promise<Preferences | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Не удалось прочитать сохранённые настройки. Выберите «Настроить заново».');
  }
}

/** Возвращает последние выбранные проекты без ключей и содержимого задач. */
export async function recentProjects(directory: string): Promise<Preferences[]> {
  try {
    return z
      .array(schema)
      .parse(JSON.parse(await readFile(join(directory, 'desktop-projects.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Не удалось прочитать список недавних проектов.');
  }
}
