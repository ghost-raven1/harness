import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { chooseTask } from '../src/interfaces/guided/tasks.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { followRun } from '../src/interfaces/guided/watch.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/watch.js', () => ({ followRun: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.resetAllMocks());

it.each([false, true])(
  'ручная проверка отменённой задачи (убрана: %s) сохраняет результат без автоматического продолжения',
  async (hidden) => {
    const current: StatusView = {
      runId: 'run',
      sessionId: 'session',
      task: 'Запиши результат',
      workspace: '/workspace',
      profile: 'test',
      status: 'cancelled',
      deletedAt: hidden ? '2026-09-12T00:00:00.000Z' : undefined,
      turns: 1,
      usage: { input: 10, output: 5 },
      learningVersion: 'baseline',
      agents: [],
      approvals: [],
      unknownInvocations: [{ id: 'write', tool: 'fs.write', arguments: '{"path":"result.txt"}' }],
      cursor: 0,
      events: [],
    };
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'runtime.history')
        return { active: [], items: [current], page: 0, pages: 1, total: 1 };
      if (method === 'runtime.resolve') {
        expect(params).toEqual({
          runId: 'run',
          invocationId: 'write',
          result: 'Проверил result.txt: записанное содержимое совпадает.',
          succeeded: true,
        });
        current.unknownInvocations = [];
        return { resolved: true };
      }
      return structuredClone(current);
    });
    const context: CliContext = {
      request: request as CliContext['request'],
      directory: () => '/unused',
      interactive: () => true,
      json: () => false,
      output: vi.fn(),
    };
    let actionMenus = 0;
    vi.mocked(followRun).mockResolvedValueOnce(structuredClone(current));
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      if (options.title === 'Мои задачи') return actionMenus ? 'back' : 'run';
      const menu = await options.load();
      if (options.title === 'Проверка прерванной операции') {
        expect(menu.options.some((item) => item.value === 'details')).toBe(true);
        return 'success';
      }
      if (actionMenus++ === 0) {
        expect(menu.options).toContainEqual({
          value: 'review',
          label: 'Проверить прерванную операцию',
        });
        expect(menu.options.some((item) => item.value === 'continue')).toBe(false);
        return 'review';
      }
      expect(menu.options.some((item) => item.value === 'review')).toBe(false);
      expect(menu.options.some((item) => item.value === 'continue')).toBe(!hidden);
      expect(menu.summary).toContain('Результаты проверки сохранены.');
      return 'back';
    });
    vi.mocked(prompts.text).mockResolvedValueOnce(
      'Проверил result.txt: записанное содержимое совпадает.',
    );
    vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
      expect((await options.load()).available).toBe(true);
      expect(options.body).toContain('{"path":"result.txt"}');
      expect(options.body).toContain('Проверил result.txt');
      return true;
    });
    await chooseTask(context, { workspace: '/workspace', profile: 'test' });
    expect(current.status).toBe('cancelled');
    expect(current.deletedAt).toBe(hidden ? '2026-09-12T00:00:00.000Z' : undefined);
    expect(actionMenus).toBe(2);
    expect(request.mock.calls.filter(([method]) => method === 'runtime.resolve')).toHaveLength(1);
    expect(
      request.mock.calls.some(([method]) => ['runtime.resume', 'runtime.run'].includes(method)),
    ).toBe(false);
  },
);
