import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, isWithin } from '../../configuration/loader.js';
import { findConfig } from '../../configuration/discovery.js';
import { initializeProject } from '../../configuration/initialize.js';
import { selected, note } from '../ui.js';
import { chooseFolder } from './folders.js';
import { chooseConnection, enterKey } from './connection.js';
import type { Preferences } from './preferences.js';
import { page } from './screen.js';
import type { SessionKeys } from './service.js';
import { liveSelect } from './live-select.js';

/** Создаёт отдельную настройку рабочего стола или использует явно выбранные авторские конфиги. */
export async function onboarding(
  directory: string,
  keys: SessionKeys,
  start?: string,
): Promise<Preferences> {
  page('Подключение проекта');
  note(
    '1. Выберите папку с файлами задачи.\n2. Подключите модель.\n3. Напишите, что нужно сделать.\n\n↑ ↓ — выбор · Enter — подтвердить · Esc — назад\nТекст задачи и выбранные моделью файлы отправляются вашему провайдеру.',
    'Первый запуск · около двух минут',
  );
  const workspace = await chooseFolder(start);
  page('Подключение модели');
  const found = findConfig(workspace);
  if (found) {
    const use = selected(
      await liveSelect({
        title: 'Настройки проекта',
        load: async () => ({
          summaryTitle: 'Найдены настройки Harness',
          summary: 'Файл настроек:\n' + found,
          message: 'Для этой папки найдены настройки Harness',
          options: [
            { value: 'project', label: 'Использовать настройки проекта' },
            {
              value: 'separate',
              label: 'Создать отдельное подключение',
              hint: 'стандартные правила; файлы проекта сохранятся',
            },
          ],
        }),
      }),
    );
    if (use === 'project') {
      const config = await loadConfig(found);
      const profile = config.value.defaultProfile;
      let allowedWorkspace = workspace;
      if (!config.value.workspaces.some((root) => isWithin(root, workspace))) {
        allowedWorkspace = selected(
          await liveSelect({
            title: 'Папка вне правил проекта',
            load: async () => ({
              summary: 'В выбранной папке работать нельзя. Выберите разрешённую папку ниже.',
              message: 'В какой разрешённой папке работать?',
              options: config.value.workspaces.map((path) => ({ value: path, label: path })),
            }),
          }),
        );
      }
      await enterKey(config.value.profiles[profile]!, keys);
      return {
        configFile: found,
        profile,
        workspace: allowedWorkspace,
      };
    }
  }
  const profile = await chooseConnection(keys);
  const configFile = await initializeProject({
    directory: join(directory, 'projects', randomUUID()),
    workspace,
    provider: profile.provider,
    model: profile.model,
    baseUrl: profile.baseUrl,
    apiKeyEnv: profile.apiKeyEnv,
    confirmWrites: true,
  });
  note(
    'Папка: ' +
      workspace +
      '\nМодель: ' +
      profile.model +
      '\n\nЗапросы к облачной модели могут быть платными. Самообучение тоже использует API; его можно приостановить в настройках.\nЧтение разрешено правилами проекта. Перед записью файлов и запуском программ стандартные настройки запрашивают ваше решение.',
    'Всё готово к работе',
  );
  return { configFile, workspace, profile: profile.provider };
}

/** Загружает выбранное подключение и запрашивает недостающий ключ. */
export async function unlockProfile(
  preferences: Preferences,
  keys: SessionKeys,
  replace = false,
): Promise<void> {
  const config = await loadConfig(preferences.configFile);
  const profile = config.value.profiles[preferences.profile];
  if (!profile) throw new Error('Профиль удалён из настроек. Выберите «Настроить заново».');
  await enterKey(profile, keys, replace);
}
