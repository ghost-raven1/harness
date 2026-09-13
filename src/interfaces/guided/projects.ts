import * as prompts from '@clack/prompts';
import { loadConfig, isWithin } from '../../configuration/loader.js';
import { addProfile } from '../../configuration/profiles.js';
import { chooseConnection } from './connection.js';
import { unlockProfile } from './onboarding.js';
import { recentProjects, savePreferences, type Preferences } from './preferences.js';
import type { DesktopService, SessionKeys } from './service.js';
import { selected } from '../ui.js';
import { page, backFromPage } from './screen.js';
import { liveSelect } from './live-select.js';

/** Переключает подключение только между задачами и сохраняет прежний проект при ошибке. */
export async function changeProject(
  kind: 'recent' | 'model',
  preferences: Preferences,
  host: DesktopService,
  keys: SessionKeys,
): Promise<void> {
  page(kind === 'recent' ? 'Недавние проекты' : 'Подключение модели');
  if (!host.isOwner || host.activeCount()) {
    prompts.log.info(
      host.isOwner
        ? 'Сначала завершите или остановите работающие задачи через «Мои задачи». Затем можно переключить подключение.'
        : 'Сервис работает в другом окне. Откройте настройки в том окне, чтобы переключить подключение.',
    );
    await backFromPage();
    return;
  }
  const restoreKeys = keys.checkpoint();
  let committed = false;
  try {
    let next = { ...preferences };
    if (kind === 'recent') {
      const projectKey = (project: Preferences): string =>
        JSON.stringify([project.configFile, project.workspace]);
      const key = selected(
        await liveSelect({
          title: 'Недавние проекты',
          load: async () => ({
            message: 'Недавние проекты',
            options: [
              ...(await recentProjects(host.directory)).map((project) => ({
                value: projectKey(project),
                label: project.workspace,
                hint: project.profile,
              })),
              { value: 'back', label: '← Назад' },
            ],
          }),
        }),
      );
      if (key === 'back') return;
      const chosen = (await recentProjects(host.directory)).find(
        (project) => projectKey(project) === key,
      );
      if (!chosen) return;
      page('Подключение проекта');
      next = { ...chosen };
      const config = await loadConfig(next.configFile);
      if (!config.value.workspaces.some((root) => isWithin(root, next.workspace)))
        throw new Error('Эта папка больше не разрешена настройками проекта.');
      await unlockProfile(next, keys);
    } else {
      const connection = await chooseConnection(keys);
      next.profile = await addProfile(next.configFile, connection);
    }
    if (host.activeCount())
      throw new Error('Во время выбора появились работающие задачи. Дождитесь их завершения.');
    await host.close();
    try {
      await host.start(next.configFile);
    } catch (error) {
      restoreKeys();
      await host.start(preferences.configFile);
      throw error;
    }
    Object.assign(preferences, next);
    await savePreferences(host.directory, preferences);
    committed = true;
    page('Подключение готово');
    prompts.log.success('Подключение выбрано для новых задач.');
    prompts.log.info('Теперь можно открыть «Новую задачу» в главном меню.');
    await backFromPage();
  } finally {
    if (!committed) restoreKeys();
  }
}
