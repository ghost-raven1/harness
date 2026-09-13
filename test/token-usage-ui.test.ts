import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { showLearning } from '../src/interfaces/commands/learning.js';
import { settings } from '../src/interfaces/guided/settings.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { note } from '../src/interfaces/ui.js';
import type { DesktopService, SessionKeys } from '../src/interfaces/guided/service.js';
import type { CliContext, LearningStatusView, TaskView } from '../src/interfaces/types.js';
import { TaskFeed } from '../src/interfaces/guided/task-feed.js';
import { taskFrame } from '../src/interfaces/guided/task-screen.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/ui.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/ui.js')>()),
  note: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const learning: LearningStatusView = {
    activeVersion: 'baseline',
    enabled: true,
    paused: false,
    dailyLimit: null,
    daily: { date: new Date().toISOString().slice(0, 10), tokens: 25 },
    jobs: [],
    candidates: [],
  };
  const context = {
    request: vi.fn(async (method: string) =>
      method === 'learning.status' ? structuredClone(learning) : {},
    ),
    directory: () => '/fixture',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  } as CliContext;
  return { learning, context };
}

it('самообучение обновляет расход без знаменателя и не показывает вчерашние токены за сегодня', async () => {
  const value = fixture();
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options).toContainEqual({
        value: 'budget',
        label: 'Расход токенов',
      });
      return 'learning';
    })
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).summary).toContain('Токены сегодня (UTC): 25');
      value.learning.daily.tokens = 40;
      const current = await options.load();
      expect(current.summary).toContain('Токены сегодня (UTC): 40');
      expect(current.summary).not.toMatch(/лимит|квот|\/\s*\d|null/i);
      value.learning.daily.date = '2000-01-01';
      expect((await options.load()).summary).toContain('Токены сегодня (UTC): 0');
      return 'back';
    });
  await settings(
    value.context,
    { configFile: '/fixture', profile: 'fixture', workspace: '/fixture' },
    {} as DesktopService,
    {} as SessionKeys,
  );
});

it('команда learning status сохраняет числовой расход без суточного ограничения', async () => {
  const value = fixture();
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
  try {
    await showLearning(value.context);
    const text = vi.mocked(note).mock.calls[0]![0];
    expect(text).toContain('Токены сегодня (UTC): 25');
    expect(text).not.toMatch(/лимит|квот|\/\s*\d|null/i);
  } finally {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  }
});

it('настройки открывают общий предел отдельным экраном рядом с расходом', async () => {
  const value = fixture();
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      const budget = menu.options.findIndex((item) => item.value === 'budget');
      expect(menu.options[budget + 1]).toEqual({ value: 'iterations', label: 'Предел шагов' });
      return 'iterations';
    })
    .mockImplementationOnce(async (options) => {
      expect(options.title).toBe('Предел шагов');
      await options.load();
      return 'back';
    });
  await settings(
    value.context,
    { configFile: '/fixture', profile: 'fixture', workspace: '/fixture' },
    {} as DesktopService,
    {} as SessionKeys,
  );
  expect(value.context.request).toHaveBeenCalledWith('iterations.status', { runId: undefined });
});

it('старый warning не возвращает квоты в живой экран задачи', () => {
  const feed = new TaskFeed();
  feed.update({
    runId: 'run',
    sessionId: 'session',
    workspace: '/fixture',
    profile: 'fixture',
    status: 'running',
    task: 'Проверка расхода',
    turns: 1,
    learningVersion: 'baseline',
    usage: { input: 100, output: 25 },
    cursor: 0,
    events: [],
    agents: [],
    approvals: [],
    unknownInvocations: [],
    output: { events: [], cursor: 0, hasMore: false },
    budget: { warning: true },
  } as unknown as TaskView);
  expect(taskFrame(feed, 80, 24, 'all', 0)).not.toMatch(/80%|квот|лимит/i);
});
