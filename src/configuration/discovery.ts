import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Ищет конфигурацию от текущей папки к корню, чтобы команды работали из подпапок проекта. */
export function findConfig(start = process.cwd()): string | undefined {
  let directory = resolve(start);
  while (true) {
    for (const relative of [
      '.harness/config/harness.json',
      'harness.json',
      'config/harness.json',
    ]) {
      const candidate = join(directory, relative);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Возвращает явный путь или найденный конфиг; при отсутствии объясняет способ настройки. */
export function configFile(explicit?: string): string {
  const found = explicit ? resolve(explicit) : findConfig();
  if (!found)
    throw new Error(
      'Конфигурация не найдена. Выполните harness init или передайте --config <файл>.',
    );
  return found;
}
