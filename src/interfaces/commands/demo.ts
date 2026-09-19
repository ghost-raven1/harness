import type { Command } from 'commander';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDemoFiles, restrictDemoCommands } from '../../application/demo.js';
import { DemoProvider, demoGoal, demoTitle } from '../../providers/demo-provider.js';
import { commandClient, serve } from '../ipc.js';
import type { CliContext } from '../types.js';
import { enterDemoBrand } from '../branding.js';
import { enterDesktopScreen } from '../guided/screen.js';
import { liveSelect } from '../guided/live-select.js';
import { prepareProject } from '../guided/project-work/setup.js';
import { browseProjects } from '../guided/project-work/list.js';
import { message } from '../../shared/primitives.js';
import { explainError } from '../guided/errors.js';
import type { TaskDraft } from '../../sessions/drafts.js';

/** Открывает самостоятельное обучение без чтения пользовательских подключений и задач. */
export function registerDemo(program: Command, context: CliContext): void {
  program
    .command('demo')
    .description('Учебный проект без сети и API-ключей')
    .action(async () => {
      if (!context.interactive() || process.env.TERM === 'dumb')
        throw new Error('Демо требует интерактивного терминала. Запустите: harness demo');
      await runDemo();
    });
}

/** Запускает отдельный локальный сервис и удаляет временные файлы только после остановки исполнителей. */
export async function startDemoSession() {
  const files = await createDemoFiles();
  let service: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    service = await serve(files.configFile, files.directory, new DemoProvider());
    restrictDemoCommands(service.app.registry);
    const owned = service;
    let closing: Promise<void> | undefined;
    return {
      ...files,
      service,
      request: commandClient(() => files.directory),
      close: (): Promise<void> =>
        (closing ??= (async () => {
          await owned.close();
          await rm(files.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        })()),
    };
  } catch (error) {
    // Даже отказ подготовки не удаляет папку ещё работающих исполнителей.
    if (service) await service.close();
    await rm(files.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    );
    throw error;
  }
}

/** Показывает обычные проектные формы с постоянной отметкой о временном учебном режиме. */
export async function runDemo(): Promise<void> {
  const leaveBrand = enterDemoBrand();
  const leaveScreen = enterDesktopScreen(process.env.HARNESS_DEMO_PARENT_SCREEN === '1');
  const starting = startDemoSession();
  let closing: Promise<void> | undefined;
  let shuttingDown = false;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await (await starting).close();
      } finally {
        if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
        process.stdin.pause();
        leaveScreen();
        leaveBrand();
      }
    })());
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void close().then(
      () => process.exit(130),
      (error: unknown) => {
        process.stderr.write(explainError(error) + '\n');
        process.exit(1);
      },
    );
  };
  // Обработчики устанавливаются до первого await: сигнал во время запуска тоже дождётся очистки.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const session = await starting;
    if (shuttingDown) return;
    const context: CliContext = {
      directory: () => session.directory,
      json: () => false,
      interactive: () => true,
      output: (value) => process.stdout.write(JSON.stringify(value) + '\n'),
      request: session.request,
    };
    const preferences = {
      configFile: session.configFile,
      workspace: session.workspace,
      profile: 'demo',
    };
    let notice = '';
    let initialDraft: TaskDraft | undefined = await context.request('drafts.create', {
      scope: { workspace: session.workspace, profile: 'demo', purpose: 'project.create' },
      text: demoGoal,
      payload: {
        kind: 'project.create',
        title: demoTitle,
        goal: demoGoal,
        workspace: session.workspace,
        profile: 'demo',
      },
    });
    while (true) {
      const choice = await liveSelect({
        title: 'Учебный проект · без подключения модели',
        load: async () => {
          const list = await context.request('projects.list', {});
          return {
            summaryTitle: 'Попробуйте весь путь',
            summary: [
              notice,
              'Ошибка в расчёте → план → неудачная попытка → тест → исправление → приёмка → экспорт.',
              'Данные временные: при выходе учебная папка и отчёты удаляются. Ваши обычные проекты сохраняются.',
            ]
              .filter(Boolean)
              .join('\n\n'),
            message: 'Начнём?',
            options: [
              {
                value: list.total ? 'projects' : 'start',
                label: list.total ? 'Открыть учебный проект' : 'Начать учебный проект',
              },
              { value: 'exit', label: 'Выйти из демо' },
            ],
          };
        },
      });
      if (typeof choice === 'symbol' || choice === 'exit') break;
      notice = '';
      try {
        if (choice === 'start') {
          const info = await context.request('system.info');
          const draft = initialDraft;
          initialDraft = undefined;
          await prepareProject(
            context,
            preferences,
            info.capabilities?.includes('projects-diff-v1') === true,
            draft,
          );
        } else await browseProjects(context, preferences);
      } catch (error) {
        if (message(error) !== 'INTERACTIVE_CANCEL') notice = explainError(error);
      }
    }
  } finally {
    try {
      await close();
    } finally {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
    }
  }
  process.stdout.write('Учебный проект завершён. Временные данные удалены. До встречи!\n');
}

/** Отделяет исполнителей демо от работающего рабочего стола и возвращает управление после выхода. */
export async function openDemoFromDesktop(): Promise<void> {
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'demo'], {
    stdio: 'inherit',
    env: { ...process.env, HARNESS_DEMO_PARENT_SCREEN: '1' },
  });
  const listeners = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    listeners.set(signal, process.listeners(signal) as NodeJS.SignalsListener[]);
    process.removeAllListeners(signal);
    process.on(signal, forward);
  }
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) =>
        code && code !== 130 ? reject(new Error('Учебное окно завершилось с ошибкой.')) : resolve(),
      );
    });
  } finally {
    for (const [signal, saved] of listeners) {
      process.off(signal, forward);
      for (const listener of saved) process.on(signal, listener);
    }
  }
}
