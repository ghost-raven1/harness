import { readFileSync } from 'node:fs';

/** Единая версия для диагностики и сервиса; тот же файл читают установщики. */
export const runtimeVersion = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
/** Отклоняет запуск на версии Node, отличной от закреплённой в проекте. */
export function assertRuntime(): void {
  if (process.version !== 'v' + runtimeVersion)
    throw new Error(
      'Нужен Node.js ' +
        runtimeVersion +
        '. Откройте «Запустить Harness»; текущая версия: ' +
        process.version,
    );
}
