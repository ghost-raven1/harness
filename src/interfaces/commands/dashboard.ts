import { serviceCompatibility } from '../service-compatibility.js';
import { isWithin } from '../../configuration/loader.js';
import type { Command } from 'commander';
import * as prompts from '@clack/prompts';
import type { CliContext, ServiceInfo } from '../types.js';
import { message } from '../../shared/primitives.js';
import { selected } from '../ui.js';
import { DesktopService, SessionKeys } from '../guided/service.js';
import { readPreferences, savePreferences, type Preferences } from '../guided/preferences.js';
import { onboarding, unlockProfile } from '../guided/onboarding.js';
import { newTask, chooseTask } from '../guided/tasks.js';
import { settings, help } from '../guided/settings.js';
import { explainError } from '../guided/errors.js';
import { activity } from '../guided/activity.js';
import { enterDesktopScreen, page, backFromPage } from '../guided/screen.js';
import { closeDesktop, type DesktopConnection } from '../guided/farewell.js';
import { browseKnowledge } from '../guided/knowledge.js';
import { liveSelect } from '../guided/live-select.js';
import { liveConfirm } from '../guided/live-confirm.js';
import { workspaceLine } from '../guided/task-layout.js';
import { learningVersionLabel } from '../guided/learning-labels.js';
import { browseProjects } from '../guided/project-work/list.js';
import { openDemoFromDesktop } from './demo.js';

/** Обычный запуск включает сервис и рабочий стол в одном окне. */
export function registerDashboard(program: Command, context: CliContext): void {
  program.action(async () => {
    if (!context.interactive()) {
      program.help();
      return;
    }
    const host = new DesktopService(context.directory());
    const leaveScreen = enterDesktopScreen();
    const keys = new SessionKeys(context.directory());
    let closing: Promise<void> | undefined;
    let shuttingDown = false;
    let connection: DesktopConnection = 'unstarted';
    const close = (): Promise<void> =>
      (closing ??= closeDesktop(host, keys, leaveScreen, host.isOwner ? 'owned' : connection));
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void close().then(
        () => process.exit(130),
        (error: unknown) => {
          prompts.log.error(explainError(error));
          process.exit(1);
        },
      );
    };
    // Обработчик остаётся до закрытия: иначе signal-exit повторно посылает сигнал во время await.
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    let reset = false;
    try {
      while (true) {
        let info = await host.connect();
        let preferences: Preferences | undefined;
        try {
          if (!reset) preferences = await readPreferences(context.directory());
        } catch (error) {
          prompts.log.warn(explainError(error));
        }
        if (!info) {
          try {
            if (!preferences) preferences = await onboarding(context.directory(), keys);
            await unlockProfile(preferences, keys);
            const spinner = activity();
            spinner.start('Открываю рабочий стол');
            try {
              info = await host.start(preferences.configFile);
            } finally {
              spinner.stop('Подготовка завершена');
            }
            await savePreferences(context.directory(), preferences);
          } catch (error) {
            if (message(error) === 'INTERACTIVE_CANCEL') {
              if (reset && (await readPreferences(context.directory()).catch(() => undefined))) {
                reset = false;
                continue;
              }
              page('Завершение настройки');
              const leave = selected(
                await prompts.confirm({
                  message: 'Закрыть приложение?',
                  initialValue: false,
                  active: 'Закрыть',
                  inactive: 'Вернуться к настройке',
                }),
              );
              if (leave) return;
            } else {
              const retry = selected(
                await liveSelect({
                  title: 'Не удалось открыть Harness',
                  load: async () => ({
                    summaryTitle: 'Как исправить',
                    summary: explainError(error, 'configuration'),
                    message: 'Следующий шаг',
                    options: [
                      { value: 'retry', label: 'Попробовать снова' },
                      { value: 'reset', label: 'Настроить заново' },
                      { value: 'help', label: 'Открыть подсказки' },
                      { value: 'exit', label: 'Закрыть' },
                    ],
                  }),
                }),
              );
              if (retry === 'exit') return;
              if (retry === 'help') {
                page('Как пользоваться');
                help();
                await backFromPage();
              }
              reset = retry === 'reset';
            }
            await host.close();
            continue;
          }
        }
        connection = host.isOwner ? 'owned' : 'attached';
        preferences = validSelection(preferences, info);
        const reconfigure = await desktop(context, preferences, info, host, keys);
        if (!reconfigure) return;
        await host.close();
        connection = 'unstarted';
        reset = true;
      }
    } finally {
      try {
        await close();
      } finally {
        process.removeListener('SIGTERM', shutdown);
        process.removeListener('SIGINT', shutdown);
      }
    }
  });
}

/** Сохраняет выбранные модель и папку, только если действующий сервис их допускает. */
function validSelection(preferences: Preferences | undefined, info: ServiceInfo): Preferences {
  return {
    configFile: info.configFile ?? preferences?.configFile ?? '',
    profile: info.profiles.some((p) => p.id === preferences?.profile)
      ? preferences!.profile
      : info.defaultProfile,
    workspace:
      preferences?.workspace &&
      info.workspaces.some((root) => isWithin(root, preferences.workspace))
        ? preferences!.workspace
        : info.workspaces[0]!,
  };
}

/** Обновляет главное меню и передаёт действия специализированным экранам. */
async function desktop(
  context: CliContext,
  preferences: Preferences,
  initial: ServiceInfo,
  host: DesktopService,
  keys: SessionKeys,
): Promise<boolean> {
  let info = initial;
  let errorMessage = '';
  while (true) {
    page('Главное меню');
    const notice = errorMessage;
    errorMessage = '';
    const choice = await liveSelect({
      title: 'Главное меню',
      load: async () => {
        const current = await context.request('system.info');
        return {
          activity: current.recoveryError
            ? { kind: 'error' as const, label: 'Сбой записи · только просмотр' }
            : (current.activeRuns ?? 0) > 0 || (current.activeProjects ?? 0) > 0
              ? {
                  kind:
                    (current.pendingApprovals ?? 0) > 0 ? ('waiting' as const) : ('busy' as const),
                  label:
                    (current.pendingApprovals ?? 0) > 0
                      ? 'Нужно ваше разрешение'
                      : 'Harness выполняет задачи',
                }
              : undefined,
          summary: [
            notice,
            serviceCompatibility(current),
            current.recoveryError
              ? 'Проверьте папку состояния и перезапустите Harness.'
              : undefined,
            workspaceLine(preferences.workspace, (process.stdout.columns || 80) - 5),
            'Модель: ' +
              (current.profiles.find((p) => p.id === preferences.profile)?.model ??
                preferences.profile),
            'В работе: ' +
              (current.activeRuns ?? 0) +
              ' · Разрешения: ' +
              (current.pendingApprovals ?? 0),
            current.activeProjects ? 'Проектов в работе: ' + current.activeProjects : undefined,
            'Уроков в базе: ' +
              (current.knowledgeCount ?? 0) +
              '\n' +
              learningVersionLabel(current.learningVersion ?? 'baseline'),
          ]
            .filter(Boolean)
            .join('\n'),
          summaryTitle: current.recoveryError ? 'Сбой записи · только просмотр' : 'Готов к работе',
          message: 'Чем займёмся?',
          options: [
            ...(!current.recoveryError
              ? [{ value: 'run', label: 'Новая задача', hint: 'опишите, что нужно сделать' }]
              : []),
            { value: 'tasks', label: 'Мои задачи', hint: 'ответы, продолжение и разрешения' },
            ...(current.capabilities?.includes('projects-v1')
              ? [{ value: 'projects', label: 'Проекты', hint: 'цель, план и проверенные этапы' }]
              : []),
            { value: 'settings', label: 'Настройки' },
            { value: 'help', label: 'Как пользоваться', hint: 'примеры и подсказки' },
            {
              value: 'demo',
              label: 'Попробовать на учебном проекте',
              hint: 'без подключения модели',
            },
            { value: 'knowledge', label: 'База знаний', hint: 'уроки, доказательства и проверки' },
            { value: 'exit', label: 'Выход' },
          ],
        };
      },
    });
    const action = typeof choice === 'symbol' || prompts.isCancel(choice) ? 'exit' : choice;
    try {
      if (action === 'exit') {
        const count = host.activeCount();
        if (count) {
          const confirm = selected(
            await liveConfirm({
              title: 'Выход из Harness',
              message: 'Приостановить работу и закрыть окно?',
              body: 'Сервис этого окна остановит задачи и приостановит проекты. История сохранится; проекты можно продолжить при следующем запуске.',
              active: 'Остановить и выйти',
              inactive: 'Вернуться',
              load: async () => ({
                available: true,
                detail: 'В работе сейчас: ' + host.activeCount(),
              }),
            }),
          );
          if (!confirm) continue;
        }
        return false;
      }
      info = await context.request('system.info');
      if (action === 'run') {
        const profile = info.profiles.find((p) => p.id === preferences.profile);
        if (!profile) throw new Error('Выбранный профиль изменился. Выберите модель в настройках.');
        if (!profile.configured) {
          if (!host.isOwner) {
            prompts.log.warn(
              'У этой модели не настроен ключ. Добавьте его в окне сервиса или выберите готовую модель в настройках.',
            );
            await backFromPage();
            continue;
          }
          await unlockProfile(preferences, keys);
        }
        await newTask(context, preferences);
      }
      if (action === 'tasks') await chooseTask(context, preferences);
      if (action === 'projects') await browseProjects(context, preferences);
      if (action === 'demo' && (await openDemoFromDesktop())) {
        process.exitCode = 130;
        return false;
      }
      if (action === 'knowledge') await browseKnowledge(context);
      if (action === 'help') {
        page('Как пользоваться');
        help();
        await backFromPage();
      }
      if (action === 'settings' && (await settings(context, preferences, host, keys))) return true;
    } catch (error) {
      if (message(error) !== 'INTERACTIVE_CANCEL') errorMessage = explainError(error);
    }
  }
}
