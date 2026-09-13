import { manageBudget } from './budget.js';
import { showIterationSettings } from './iterations.js';
import { page, backFromPage } from './screen.js';
import { changeProject } from './projects.js';
import { isWithin } from '../../configuration/loader.js';
import * as prompts from '@clack/prompts';
import type { CliContext, ServiceInfo, LearningStatusView } from '../types.js';
import type { Preferences } from './preferences.js';
import { savePreferences } from './preferences.js';
import { unlockProfile } from './onboarding.js';
import type { DesktopService, SessionKeys } from './service.js';
import { note, selected } from '../ui.js';
import { showDiagnostics } from '../commands/doctor.js';
import { browseKnowledge } from './knowledge.js';
import { liveSelect } from './live-select.js';
import { readText } from './text-reader.js';
import { diagnose } from '../diagnostics.js';
import { resetData } from './reset-data.js';
import { showDiagnostics as diagnosticLog } from './diagnostics.js';

/** Размещает редкие настройки отдельно от ежедневной работы с задачами. */
export async function settings(
  context: CliContext,
  preferences: Preferences,
  host: DesktopService,
  keys: SessionKeys,
): Promise<boolean> {
  page('Настройки');
  const action = selected(
    await liveSelect({
      title: 'Настройки',
      load: async () => {
        const current = await context.request<ServiceInfo>('system.info');
        return {
          summary:
            'В работе: ' +
            (current.activeRuns ?? 0) +
            ' · Разрешения: ' +
            (current.pendingApprovals ?? 0),
          message: 'Настройки',
          options: [
            {
              value: 'model',
              label: 'Подключить другую модель',
              hint: 'без повторной настройки проекта',
            },
            { value: 'recent', label: 'Недавние проекты' },
            { value: 'profile', label: 'Выбрать модель или папку из настроек проекта' },
            { value: 'key', label: 'Ключ API', hint: 'заменить ключ и выбрать способ хранения' },
            { value: 'project', label: 'Настроить другой проект или подключение' },
            {
              value: 'learning',
              label: 'Самообучение',
              hint: 'включить, приостановить, посмотреть опыт',
            },
            { value: 'budget', label: 'Расход токенов' },
            { value: 'iterations', label: 'Предел шагов' },
            { value: 'doctor', label: 'Проверить, всё ли работает' },
            {
              value: 'logging',
              label: 'Диагностический лог',
              hint: 'запись технических событий в файл',
            },
            { value: 'files', label: 'Где находятся настройки и история' },
            {
              value: 'reset',
              label: 'Очистка данных',
              hint: 'выбрать задачи, знания или всё вместе',
            },
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (action === 'model' || action === 'recent')
    await changeProject(action, preferences, host, keys);
  if (action === 'project') {
    page('Новое подключение');
    if (!host.isOwner) {
      prompts.log.info(
        'Сервис открыт в другом окне. Завершите его там, затем перезапустите это окно для нового подключения.',
      );
      await backFromPage();
      return false;
    }
    if (host.activeCount()) {
      prompts.log.info('Сначала завершите или остановите работающие задачи через «Мои задачи».');
      await backFromPage();
      return false;
    }
    return true;
  }
  if (action === 'key') {
    page('Ключ API');
    const info = await context.request<ServiceInfo>('system.info');
    if (info.profiles.find((profile) => profile.id === preferences.profile)?.provider === 'codex') {
      note(
        'Codex использует вход в аккаунт. Для смены подключения выберите «Подключить другую модель → Codex». Ключ API не нужен.',
        'Аккаунт Codex',
      );
      await backFromPage();
      return false;
    }
    if (!host.isOwner)
      prompts.log.info(
        'Ключ задаётся в окне, где запущен сервис. Этот рабочий стол подключён к уже работающему сервису.',
      );
    else {
      if (host.activeCount())
        prompts.log.info(
          'Сначала дождитесь завершения текущих задач, чтобы ключ не менялся во время выполнения.',
        );
      else {
        await unlockProfile(preferences, keys, true);
        page('Ключ API');
        prompts.log.success('Настройки ключа проверены.');
      }
    }
    await backFromPage();
  }
  if (action === 'profile') {
    page('Модель и папка проекта');
    const profile = selected(
      await liveSelect({
        title: 'Модель и папка проекта',
        initialValue: preferences.profile,
        load: async () => ({
          message: 'Модель',
          options: (await context.request<ServiceInfo>('system.info')).profiles.map((p) => ({
            value: p.id,
            label: p.model,
            hint: p.configured ? p.provider : 'нужен ключ',
          })),
        }),
      }),
    );
    const current = await context.request<ServiceInfo>('system.info');
    const workspace =
      current.workspaces.length === 1
        ? isWithin(current.workspaces[0]!, preferences.workspace)
          ? preferences.workspace
          : current.workspaces[0]!
        : selected(
            await liveSelect({
              title: 'Папка проекта',
              initialValue: preferences.workspace,
              load: async () => ({
                message: 'Папка для новых задач',
                options: (await context.request<ServiceInfo>('system.info')).workspaces.map(
                  (path) => ({ value: path, label: path }),
                ),
              }),
            }),
          );
    page('Подключение выбранной модели');
    if (host.isOwner) await unlockProfile({ ...preferences, profile }, keys);
    preferences.profile = profile;
    preferences.workspace = workspace;
    if (preferences.configFile) await savePreferences(context.directory(), preferences);
    page('Выбор сохранён');
    prompts.log.success('Выбор сохранён для новых задач.');
    note('Модель: ' + profile + '\nПапка: ' + workspace, 'Следующая задача');
    await backFromPage();
  }
  if (action === 'learning') {
    page('Самообучение');
    const choice = selected(
      await liveSelect({
        title: 'Самообучение',
        load: async () => {
          const state = await context.request<LearningStatusView>('learning.status');
          const today = new Date().toISOString().slice(0, 10);
          const usedTokens = state.daily.date === today ? state.daily.tokens : 0;
          return {
            summary:
              'Состояние: ' +
              (!state.enabled
                ? 'отключено конфигурацией'
                : state.paused
                  ? 'на паузе'
                  : 'включено') +
              '\nТокены сегодня (UTC): ' +
              usedTokens +
              '\nВ очереди: ' +
              state.jobs.filter((job) => job.status === 'queued').length +
              '\n' +
              (state.evaluationReady
                ? 'Контрольные задачи настроены.'
                : 'Контрольного набора пока нет. Уроки не применяются автоматически.'),
            summaryTitle: 'Самообучение',
            message: 'Управление опытом',
            options: [
              ...(state.enabled
                ? [
                    {
                      value: state.paused ? 'resume' : 'pause',
                      label: state.paused ? 'Возобновить обучение' : 'Приостановить обучение',
                    },
                  ]
                : []),
              { value: 'details', label: 'Показать очередь и уроки' },
              { value: 'back', label: '← Назад' },
            ],
          };
        },
      }),
    );
    if (choice === 'resume' || choice === 'pause') {
      await context.request(choice === 'resume' ? 'learning.resume' : 'learning.pause');
      page('Самообучение');
      prompts.log.success(
        choice === 'resume' ? 'Обучение возобновлено' : 'Обучение приостановлено',
      );
      prompts.log.info('Сохранённые уроки остаются доступны. Текущие задачи продолжат работу.');
      await backFromPage();
    }
    if (choice === 'details') {
      await browseKnowledge(context);
    }
  }
  if (action === 'budget') await manageBudget(context);
  if (action === 'iterations') await showIterationSettings(context);
  if (action === 'reset') await resetData(context);
  if (action === 'logging') await diagnosticLog(context);
  if (action === 'doctor') {
    page('Диагностика');
    const previousExitCode = process.exitCode;
    try {
      if (process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb') {
        const load = async () => {
          const report = await diagnose(context.directory());
          return {
            tabs: [
              {
                id: 'diagnostics',
                label: 'Проверки',
                text: report.checks
                  .map(
                    (check) =>
                      check.name + ': ' + check.detail + (check.hint ? '\n' + check.hint : ''),
                  )
                  .join('\n\n'),
              },
            ],
            subtitle: report.ready ? 'Сервис готов' : 'Нужна проверка подключения',
          };
        };
        const current = await load();
        await readText('Диагностика', current.tabs, { subtitle: current.subtitle, load });
      } else {
        await showDiagnostics(context);
        await backFromPage();
      }
    } finally {
      process.exitCode = previousExitCode;
    }
  }
  if (action === 'files') {
    page('Ваши данные');
    note(
      'Конфиг проекта: ' +
        (preferences.configFile || 'заданы в окне сервиса') +
        '\nИстория и опыт: ' +
        context.directory() +
        '\nВыбор рабочего стола: desktop.json' +
        '\nФайл находится в папке истории выше.' +
        '\nКлючи: память окна или хранилище системы.',
      'Ваши данные',
    );
    await backFromPage();
  }
  return false;
}

export function help(): void {
  note(
    'Новая задача: «Объясни устройство проекта».\nМои задачи: ответы, история и продолжение.\nВ меню: ↑↓ — выбор · Enter — подтвердить.\nВ задаче: Tab — вкладки · ↑↓ — прокрутка.\nEsc — назад. Ctrl+C в задаче — остановить.\nПроверяйте разрешения на файлы и команды.\nКлюч API вводится только в настройках.\nИстория сохраняется автоматически.',
    'Как пользоваться',
  );
}
