import { beforeEach, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { Command } from 'commander';
import type { RunInsights, ActivityEvent } from '../src/insights/schema.js';
import type { CliContext } from '../src/interfaces/types.js';
import { parseCommandInput } from '../src/interfaces/contracts/index.js';
import {
  browseSpecialists,
  inspectSpecialist,
} from '../src/interfaces/guided/specialists/screens.js';
import {
  browseProjectSpecialists,
  projectAttemptLabel,
} from '../src/interfaces/guided/specialists/project.js';
import {
  agentTree,
  agentSummary,
  runSummary,
  specialistTabs,
  usageText,
} from '../src/interfaces/guided/specialists/format.js';
import { relatedChecks } from '../src/interfaces/guided/specialists/checks.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText, ReaderState } from '../src/interfaces/guided/text-reader.js';
import { registerInsightsCommand } from '../src/interfaces/commands/insights.js';
import { registerProjectCommands } from '../src/interfaces/commands/projects.js';

vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
vi.mock('../src/interfaces/guided/text-reader.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/text-reader.js')>()),
  readText: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
const runId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const childId = '33333333-3333-4333-8333-333333333333';
const usage = {
  provider: { input: 7, output: 3, requests: 1 },
  estimate: { input: 11, output: 5, requests: 2 },
  unavailable: 1,
};
const snapshot: RunInsights = {
  runId,
  profile: 'fixture',
  status: 'running',
  completeness: 'complete',
  activeMs: 62000,
  pauseMs: 4000,
  usage,
  retries: 1,
  legacyUsage: { input: 0, output: 0 },
  roles: [
    {
      agentId,
      episodeId: 'episode',
      role: 'developer',
      profile: 'fixture',
      phases: { 'model.request': 5000 },
      usage,
      retries: 1,
      interrupted: 0,
    },
  ],
  agents: [
    {
      id: agentId,
      role: 'developer',
      profile: 'fixture',
      task: 'Проверить доступность',
      status: 'waiting',
      phases: ['children'],
      elapsedMs: 5000,
    },
    {
      id: childId,
      parentId: agentId,
      role: 'developer',
      profile: 'other',
      task: 'Сделать тест',
      status: 'running',
      phases: ['model.request'],
      elapsedMs: 2000,
      reason: 'Ожидание ответа',
    },
  ],
};

/** Ответы читающего стенда зависят только от указанной страницы, без модели и файлов. */
function context(
  request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'system.info') return { capabilities: ['execution-insights-v1'] };
    if (method === 'runtime.insights') return snapshot;
    if (method === 'runtime.activity')
      return {
        events: [
          {
            schemaVersion: 1,
            seq: Number(params?.cursor ?? 0) + 1,
            at: '2026-09-20T00:00:00.000Z',
            agentId: params?.agentId,
            role: 'developer',
            profile: 'fixture',
            episodeId: runId,
            processId: runId,
            runId,
            type: 'start',
            phase: 'model.request',
          } as ActivityEvent,
        ],
        cursor: params?.cursor ? 200 : 100,
        hasMore: !params?.cursor,
        completeness: 'complete',
      };
    return {};
  }),
) {
  return {
    request,
    output: vi.fn(),
    json: () => true,
    interactive: () => false,
  } as unknown as CliContext;
}

it('контракты ограничивают страницы и отвергают неизвестные поля до чтения', () => {
  expect(parseCommandInput('runtime.activity', { runId })).toEqual({
    runId,
    cursor: 0,
    limit: 100,
  });
  expect(() => parseCommandInput('runtime.activity', { runId, limit: 101 })).toThrow();
  expect(() =>
    parseCommandInput('runtime.activity', { runId, agentId: 'foreign', secret: true }),
  ).toThrow();
  expect(() =>
    parseCommandInput('projects.insights', { projectId: '../other', limit: 20 }),
  ).toThrow();
  expect(() =>
    parseCommandInput('projects.insights', { projectId: 'project', limit: 21 }),
  ).toThrow();
});

it('дерево сохраняет одинаковые роли, родителя и осиротевшую ветку без зацикливания', () => {
  const orphan = { ...snapshot.agents[1]!, id: 'orphan', parentId: 'missing' };
  const cycle = { ...snapshot.agents[1]!, id: 'cycle', parentId: 'cycle' };
  const tree = agentTree([snapshot.agents[1]!, orphan, snapshot.agents[0]!, cycle]);
  expect(tree.map(({ agent, depth }) => [agent.id, depth])).toEqual([
    ['orphan', 0],
    [agentId, 0],
    [childId, 1],
    ['cycle', 0],
  ]);
  const summary = agentSummary({
    ...snapshot.agents[0]!,
    phases: ['run', 'agent', 'model.request', 'model.first_output'],
  });
  expect(summary).toContain('Ожидание первого ответа');
  expect(summary).not.toContain('Запрос к модели');
  expect(summary).not.toContain('Работа специалиста');
});

it('провайдер, оценка и неизвестный расход различаются; прошлые роли не подменяют текущую', () => {
  expect(usageText(usage)).toContain('Провайдер: 7 вход / 3 выход');
  expect(usageText(usage)).toContain('Оценка: 11 вход / 5 выход');
  const tabs = specialistTabs(
    {
      ...snapshot,
      completeness: 'partial',
      roles: [
        ...snapshot.roles,
        { ...snapshot.roles[0]!, episodeId: 'next-episode', role: 'reviewer' },
      ],
    },
    agentId,
    'Журнал',
  );
  expect(tabs[1]?.text).toContain('Метрики неполные');
  expect(tabs[1]?.text).toContain('Роль: developer');
  expect(tabs[1]?.text).toContain('Роль: reviewer');
  expect(tabs[1]?.text).toContain('не равна времени задачи');
});

it.each([48, 80])(
  'карточка в %i×24 очищает управляющий вывод и сохраняет вкладку при обновлении',
  (width) => {
    const tabs = specialistTabs(
      { ...snapshot, agents: [{ ...snapshot.agents[0]!, task: 'Задание\u001b[2J\n'.repeat(40) }] },
      agentId,
      'Журнал',
    );
    const reader = new ReaderState({ tabs });
    reader.key({ name: 'tab' });
    reader.update({ tabs: specialistTabs(snapshot, agentId, 'Новый журнал') });
    const frame = reader.frame('Работа специалиста', width, 24);
    expect(frame).toContain('Время');
    expect(frame).not.toContain('\u001b[2J');
    expect(stripAnsi(frame).split('\n').length).toBeLessThanOrEqual(24);
    expect(
      stripAnsi(frame)
        .split('\n')
        .every((line) => stringWidth(line) <= width),
    ).toBe(true);
  },
);

it('карточка фильтрует журнал по agentId и не скачивает другие страницы до выбора', async () => {
  const ctx = context();
  let reads = 0;
  vi.mocked(readText).mockImplementation(async (_title, _tabs, options) => {
    await options?.load?.();
    return reads++ < 2 ? 'action' : 'back';
  });
  let menus = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    const value = menus++ ? 'previous' : 'next';
    expect(menu.options.some((item) => item.value === value)).toBe(true);
    return value;
  });
  await inspectSpecialist(ctx, runId, childId);
  const calls = vi
    .mocked(ctx.request)
    .mock.calls.filter(([method]) => method === 'runtime.activity');
  expect(
    calls.every(([, params]) => params && 'agentId' in params && params.agentId === childId),
  ).toBe(true);
  expect(
    calls.map(([, params]) => (params && 'cursor' in params ? params.cursor : undefined)),
  ).toEqual([0, 0, 0, 100, 100, 100, 0, 0]);
  expect(calls.every(([, params]) => params && 'limit' in params && params.limit === 100)).toBe(
    true,
  );
});

it('при перестановке агентов открывается выбранный ID и сохраняется выделение', async () => {
  const ctx = context();
  let menus = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    await options.load();
    if (menus++ === 0) return 'agent:' + childId;
    expect(options.initialValue).toBe('agent:' + childId);
    return 'back';
  });
  vi.mocked(readText).mockImplementation(async (_title, tabs) => {
    expect(tabs[0]?.text).toContain('Сделать тест');
    return 'back';
  });
  await browseSpecialists(ctx, runId);
});

it('дерево читается по 50 специалистов, сохраняет глубину и выбранный ID каждой страницы', async () => {
  const first = Array.from({ length: 50 }, (_, index) => ({
    ...snapshot.agents[0]!,
    id: index ? 'other-' + index : agentId,
    depth: 0,
  }));
  const child = { ...snapshot.agents[1]!, depth: 3 };
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'system.info') return { capabilities: ['execution-insights-v1'] };
    if (method === 'runtime.activity')
      return { events: [], cursor: 0, hasMore: false, completeness: 'complete' };
    return {
      ...snapshot,
      agentOffset: params?.agentOffset ?? 0,
      agentTotal: 51,
      agents: params?.agentId
        ? [params.agentId === childId ? child : first[0]]
        : params?.agentOffset
          ? [child]
          : first,
    };
  });
  let page = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('специалистов: 51');
    const current = page++;
    if (current === 0) return 'agent:' + agentId;
    if (current === 1 || current === 4) expect(options.initialValue).toBe('agent:' + agentId);
    if (current === 1) return 'next';
    if (current === 2) {
      expect(menu.message).toContain('2/2');
      expect(menu.options[0]?.label).toBe('    ↳ developer');
      expect(menu.options.some((item) => item.value === 'next')).toBe(false);
      return 'agent:' + childId;
    }
    if (current === 3) {
      expect(options.initialValue).toBe('agent:' + childId);
      return 'previous';
    }
    return 'back';
  });
  vi.mocked(readText).mockResolvedValue('back');
  await browseSpecialists(context(request), runId);
  const pages = request.mock.calls.filter(
    ([method, params]) => method === 'runtime.insights' && !params?.agentId,
  );
  expect(pages.map(([, params]) => params?.agentOffset)).toEqual([0, 0, 50, 50, 0]);
  expect(pages.every(([, params]) => params?.agentLimit === 50)).toBe(true);
});

it('старому сервису не отправляются новые команды экранов и автоматизации', async () => {
  const request = vi.fn(async (_method: string) => ({ capabilities: [] }));
  const ctx = context(request);
  await browseSpecialists(ctx, runId);
  await browseProjectSpecialists(ctx, 'project');
  const program = new Command().exitOverride();
  registerInsightsCommand(program, ctx);
  registerProjectCommands(program, ctx);
  await expect(program.parseAsync(['insights', runId], { from: 'user' })).rejects.toThrow(
    'Обновите сервис',
  );
  await expect(
    program.parseAsync(['projects', 'insights', 'project'], { from: 'user' }),
  ).rejects.toThrow('Обновите сервис');
  expect(request.mock.calls.every(([method]) => method === 'system.info')).toBe(true);
  expect(liveSelect).not.toHaveBeenCalled();
});

it('проектная команда отдаёт ограниченную страницу без смешивания разных попыток', async () => {
  const ctx = context();
  const program = new Command().exitOverride();
  registerProjectCommands(program, ctx);
  await program.parseAsync(['projects', 'insights', 'project', '--offset', '20'], { from: 'user' });
  expect(ctx.request).toHaveBeenCalledWith('projects.insights', {
    projectId: 'project',
    offset: 20,
    limit: 20,
  });
  expect(
    projectAttemptLabel({
      runId,
      stageId: 'verify',
      attempt: 1,
      kind: 'stage',
      insights: snapshot,
    }),
  ).toContain('попытка 1');
  expect(
    projectAttemptLabel({
      runId: childId,
      stageId: 'verify',
      attempt: 2,
      kind: 'stage',
      insights: snapshot,
    }),
  ).toContain('попытка 2');
});

it('команда insights читает выбранную страницу по 50 специалистов и объясняет смещение', async () => {
  const ctx = context();
  const program = new Command().exitOverride();
  registerInsightsCommand(program, ctx);
  expect(program.commands[0]?.helpInformation()).toMatch(/50\s+специалистов/);
  await program.parseAsync(['insights', runId, '--offset', '50'], { from: 'user' });
  expect(ctx.request).toHaveBeenCalledWith('runtime.insights', {
    runId,
    agentOffset: 50,
    agentLimit: 50,
  });
  expect(ctx.output).toHaveBeenCalledWith(snapshot);
});

it.each(['-1', '1.5', 'abc', '9007199254740992'])(
  'неверное смещение %s отклоняется до подключения к сервису',
  async (offset) => {
    const ctx = context();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
    registerInsightsCommand(program, ctx);
    await expect(
      program.parseAsync(['insights', runId, '--offset', offset], { from: 'user' }),
    ).rejects.toThrow('Нужно целое неотрицательное число');
    expect(ctx.request).not.toHaveBeenCalled();
  },
);

it('связанные проверки не подставляют доказательства другой попытки', async () => {
  const request = vi.fn(async (_method: string) => ({
    items: [
      {
        id: 'current',
        runId: 'checks-run',
        stageId: 'verify',
        attempt: 2,
        phase: 'stage',
        current: true,
      },
      {
        id: 'old',
        runId: 'old-run',
        stageId: 'verify',
        attempt: 1,
        phase: 'stage',
        current: false,
      },
    ],
    total: 2,
  }));
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.options.map((item) => item.value)).toEqual(['report:current', 'back']);
    return 'back';
  });
  await relatedChecks(context(request), runId, {
    projectId: 'project',
    stageId: 'verify',
    attempt: 2,
  });
});

it('старый запуск не получает выдуманное нулевое время, пауза видна поверх статуса агента', () => {
  const previous = {
    ...snapshot,
    status: 'paused',
    completeness: 'unavailable' as const,
    roles: [],
    activeMs: 0,
  };
  expect(runSummary(previous)).toContain('не записывалось');
  expect(runSummary(previous)).not.toContain('Работа: 0 с');
  const tabs = specialistTabs(previous, childId, 'Нет старых событий');
  expect(tabs[0]?.text).toContain('Задача: Приостановлено');
  expect(tabs[0]?.text).toContain('время не записывалось');
  const compacted = specialistTabs({ ...snapshot, rolesTruncated: true }, agentId, 'События');
  expect(compacted[1]?.text).toContain('Старые события доступны во вкладке «Журнал»');
});

it('полный ответ дочернего специалиста читается отдельно от курсора его журнала', async () => {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'runtime.activity')
      return { events: [], cursor: 0, hasMore: false, completeness: 'complete' };
    const resultCursor = Number(params?.resultCursor ?? 0);
    return {
      ...snapshot,
      agents: [
        {
          ...snapshot.agents[1],
          result: resultCursor ? 'Конец ответа дочернего агента' : 'А'.repeat(16384),
          resultCursor,
          resultLength: 16411,
          resultTruncated: !resultCursor,
        },
      ],
    };
  });
  let reads = 0;
  vi.mocked(readText).mockImplementation(async (_title, tabs) => {
    if (reads++ === 0) {
      expect(tabs[3]?.text).toContain('продолжение через Enter');
      return 'action';
    }
    expect(tabs[3]?.text).toContain('Конец ответа дочернего агента');
    return 'back';
  });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    expect((await options.load()).options.some((item) => item.value === 'result-next')).toBe(true);
    return 'result-next';
  });
  await inspectSpecialist(context(request), runId, childId);
  expect(
    request.mock.calls
      .filter(([method]) => method === 'runtime.insights')
      .map(([, params]) => params?.resultCursor),
  ).toEqual([0, 0, 16384]);
  expect(request.mock.calls.every(([, params]) => params?.agentId === childId)).toBe(true);
  expect(
    request.mock.calls
      .filter(([method]) => method === 'runtime.activity')
      .every(([, params]) => params?.cursor === 0),
  ).toBe(true);
});
