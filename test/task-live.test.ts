import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { chooseTask } from '../src/interfaces/guided/tasks.js';
import { manageBudget, type BudgetView } from '../src/interfaces/guided/budget.js';
import { restoreFile } from '../src/interfaces/guided/file-preview.js';
import { showTaskDetails } from '../src/interfaces/guided/task-details.js';
import { deleteTask } from '../src/interfaces/guided/delete-task.js';
import type { CliContext, TaskView } from '../src/interfaces/types.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(liveConfirm).mockImplementation((options) =>
    prompts.confirm({
      message: options.message,
      initialValue: false,
      active: options.active,
      inactive: options.inactive,
    }),
  );
});

function task(): TaskView {
  return {
    runId: 'run',
    task: 'Проверка обновления',
    sessionId: 'session',
    workspace: '/workspace',
    profile: 'test',
    status: 'completed',
    turns: 1,
    learningVersion: 'baseline',
    usage: { input: 12, output: 4 },
    result: 'Готово',
    cursor: 0,
    agents: [],
    approvals: [],
    unknownInvocations: [],
    events: [],
    output: { events: [], cursor: 0, hasMore: false },
    fileChanges: [
      {
        id: 'change-1',
        path: 'result.txt',
        status: 'applied',
        existed: true,
        beforeHash: 'before',
        afterHash: 'after',
      },
    ],
  };
}
function client(request: (method: string, params?: unknown) => Promise<unknown>): CliContext {
  return {
    request: request as CliContext['request'],
    directory: () => '/unused',
    interactive: () => false,
    json: () => true,
    output: vi.fn(),
  };
}
const budget: BudgetView = {
  date: '2026-09-12',
  runReserved: 50,
  runLimit: null,
  dailyLimit: null,
  warning: false,
  daily: { tasks: 50, learning: 0, reportedTasks: 35, reportedLearning: 0 },
} as BudgetView;

it('список и действия перечитывают данные; скрытие после Enter не запускает удаление', async () => {
  const current = task();
  const request = vi.fn(async (method: string) => {
    if (method === 'runtime.history')
      return {
        active: [],
        items: [{ runId: 'run', task: current.task, status: current.status }],
        page: 0,
        pages: 1,
        total: 1,
      };
    return structuredClone(current);
  });
  let actionMenus = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    if (options.title === 'Мои задачи') {
      if (current.deletedAt) return 'back';
      const first = await options.load();
      expect(first.options[0]?.hint).toBe('Ответ получен');
      current.status = 'failed';
      const refreshed = await options.load();
      expect(refreshed.options[0]?.hint).toBe('Ошибка');
      current.status = 'completed';
      return 'run';
    }
    const menu = await options.load();
    if (actionMenus++ === 0) {
      expect(menu.options.some((item) => item.value === 'delete')).toBe(true);
      current.deletedAt = '2026-09-12T00:00:00.000Z';
      return 'delete';
    }
    expect(menu.options.map((item) => item.value)).toEqual([
      'answer',
      'save',
      'details',
      'history',
      'purge',
      'back',
    ]);
    expect(menu.summary).toContain('Состояние изменилось');
    return 'back';
  });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(
    request.mock.calls.every(([method]) =>
      ['runtime.history', 'runtime.status', 'runtime.task'].includes(method),
    ),
  ).toBe(true);
  expect(prompts.confirm).not.toHaveBeenCalled();
});

it('расход задачи обновляет данные провайдера и оценку, не предлагая изменения квоты', async () => {
  const current = task();
  let consumed = 50;
  const request = vi.fn(async (method: string) =>
    method === 'budget.status' ? { ...budget, runReserved: consumed } : structuredClone(current),
  );
  vi.mocked(readText).mockImplementation(async (title, tabs, options) => {
    expect(title).toBe('Расход токенов задачи');
    expect(tabs[0]!.text).toContain('Всего: 16');
    current.status = 'paused';
    current.usage.input = 60;
    consumed = 80;
    const refreshed = await options!.load!();
    expect(refreshed.tabs[0]!.text).toContain('Всего: 64');
    expect(refreshed.tabs[0]!.text).toContain('Оценка Harness: 80');
    expect(refreshed.tabs[0]!.text).not.toMatch(/квот|лимит|80%|Добавить|\/\s*\d/i);
    expect(options!.actionLabel).toBeUndefined();
    return 'back';
  });
  await manageBudget(client(request), { runId: 'run', status: 'paused' });
  expect(prompts.text).not.toHaveBeenCalled();
  expect(
    request.mock.calls.every(([method]) => ['budget.status', 'runtime.status'].includes(method)),
  ).toBe(true);
});

it('общий расход отдельно показывает задачи и обучение, оставаясь только чтением', async () => {
  const usage = structuredClone(budget);
  const request = vi.fn(async (_method: string) => structuredClone(usage));
  vi.mocked(readText).mockImplementation(async (title, tabs, options) => {
    expect(title).toBe('Расход токенов');
    expect(tabs[0]!.text).toContain('Провайдер сообщил\nЗадачи: 35\nОбучение: 0\nВсего: 35');
    usage.daily.reportedLearning = 7;
    usage.daily.learning = 25;
    const refreshed = await options!.load!();
    expect(refreshed.tabs[0]!.text).toContain('Обучение: 7\nВсего: 42');
    expect(refreshed.tabs[0]!.text).toContain(
      'Оценка Harness\nЗадачи: 50\nОбучение: 25\nВсего: 75',
    );
    expect(refreshed.tabs[0]!.text).not.toMatch(/квот|лимит|80%|Добавить|\/\s*\d/i);
    return 'back';
  });
  await manageBudget(client(request));
  expect(request.mock.calls.every(([method]) => method === 'budget.status')).toBe(true);
  expect(prompts.confirm).not.toHaveBeenCalled();
});

it('удаление открытой задачи очищает расход и возвращает в каталог вместо старых цифр', async () => {
  const current = task();
  let removed = false;
  const request = vi.fn(async (method: string) => {
    if (method === 'runtime.history')
      return {
        active: [],
        items: removed ? [] : [current],
        page: 0,
        pages: 1,
        total: removed ? 0 : 1,
      };
    if (removed) throw new ResourceNotFoundError('task');
    return method === 'budget.status' ? structuredClone(budget) : structuredClone(current);
  });
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockResolvedValueOnce('budget')
    .mockImplementationOnce(async (options) => {
      expect(options.title).toBe('Мои задачи');
      expect((await options.load()).options[0]?.value).toBe('new');
      return 'back';
    });
  vi.mocked(readText)
    .mockImplementationOnce(async (_title, tabs, options) => {
      expect(tabs[0]!.text).toContain('Всего: 16');
      removed = true;
      const error = await options!.load!().catch((error: unknown) => error);
      expect(options!.exitOnError!(error)).toBe(true);
      throw error;
    })
    .mockImplementationOnce(async (title, tabs) => {
      expect(title).toBe('Задача удалена');
      expect(JSON.stringify(tabs)).not.toContain('Всего: 16');
      return 'back';
    });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(liveSelect).toHaveBeenCalledTimes(3);
  expect(readText).toHaveBeenCalledTimes(2);
});

it('список файлов убирает восстановленные изменения и не открывает устаревший выбор', async () => {
  const current = task();
  const request = vi.fn(async () => structuredClone(current));
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    expect((await options.load()).options[0]?.value).toBe('change-1');
    current.fileChanges![0]!.status = 'restored';
    expect((await options.load()).options.map((item) => item.value)).toEqual(['back']);
    return 'change-1';
  });
  await expect(restoreFile(client(request), 'run')).rejects.toThrow(
    'Откройте список файлов заново',
  );
  expect(prompts.confirm).not.toHaveBeenCalled();
});

it('обновление списка не заменяет закреплённый diff и токен подтверждённой операции', async () => {
  const current = task();
  const request = vi.fn(async (method: string) => {
    if (method === 'files.previewRestore')
      return { path: 'result.txt', diff: '-после\n+до', previewToken: 'fixed-token' };
    return structuredClone(current);
  });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    await options.load();
    return 'change-1';
  });
  vi.mocked(prompts.confirm).mockImplementation(async () => {
    current.fileChanges!.push({
      id: 'another',
      path: 'another.txt',
      status: 'applied',
      existed: true,
      beforeHash: 'before',
      afterHash: 'after',
    });
    return true;
  });
  await restoreFile(client(request), 'run');
  expect(request).toHaveBeenCalledWith('files.restore', {
    runId: 'run',
    changeId: 'change-1',
    previewToken: 'fixed-token',
  });
  expect(request.mock.calls.filter(([method]) => method === 'files.previewRestore')).toHaveLength(
    1,
  );
});

it('полные сведения получают новые шаги, токены и изменения через загрузчик', async () => {
  const current = task();
  const request = vi.fn(async () => structuredClone(current));
  vi.mocked(readText).mockImplementation(async (_title, _tabs, options) => {
    current.turns = 8;
    current.usage.input = 400;
    current.deletedAt = '2026-09-12';
    const refreshed = await options!.load!();
    expect(refreshed.tabs.find((tab) => tab.id === 'execution')?.text).toContain('Шагов: 8');
    expect(refreshed.tabs.find((tab) => tab.id === 'execution')?.text).toContain(
      'Токены: 400 вход',
    );
    expect(refreshed.subtitle).toBe('Скрыта · только чтение');
    return 'back';
  });
  await showTaskDetails(client(request), current);
  expect(request).toHaveBeenCalledExactlyOnceWith('runtime.status', { runId: 'run' });
});

it.each(['restore', 'delete'] as const)(
  '%s: скрытие в другом окне обновляет подтверждение без замены его деталей и без операции',
  async (action) => {
    const current = task();
    const request = vi.fn(async (method: string) => {
      if (method === 'files.previewRestore')
        return { path: 'result.txt', diff: '-после\n+до', previewToken: 'fixed-token' };
      return structuredClone(current);
    });
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      await options.load();
      return 'change-1';
    });
    vi.mocked(liveConfirm).mockImplementation(async (options) => {
      const body = options.body;
      expect((await options.load()).available).toBe(true);
      current.deletedAt = '2026-09-12T00:00:00.000Z';
      expect((await options.load()).available).toBe(false);
      expect(options.body).toBe(body);
      if (action === 'restore') expect(body).toContain('-после\n+до');
      return undefined;
    });
    if (action === 'restore') await restoreFile(client(request), current.runId);
    if (action === 'delete') expect(await deleteTask(client(request), current)).toBe(false);
    expect(
      request.mock.calls.some(([method]) =>
        ['files.restore', 'runtime.delete', 'runtime.cancel'].includes(method),
      ),
    ).toBe(false);
  },
);
