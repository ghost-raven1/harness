import { beforeEach, expect, it, vi } from 'vitest';
import { showTaskAnswer } from '../src/interfaces/guided/task-answer.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';

vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const initial = {
  runId: 'run',
  status: 'completed',
  result: 'Какие ключи: **настройки** или API?\n\nУточните раздел.',
} as StatusView;

function client(request: ReturnType<typeof vi.fn>): CliContext {
  return { request, directory: () => '/unused' } as unknown as CliContext;
}

it('полный ответ сохраняет абзацы и обновляется без нового запуска', async () => {
  const current = { ...initial, result: 'Первая строка\n' + 'Содержимое\n'.repeat(150) + 'Конец' };
  const request = vi.fn().mockResolvedValue(current);
  vi.mocked(readText).mockImplementation(async (title, tabs, options) => {
    expect(title).toBe('Ответ модели');
    expect(tabs[0]!.text).toBe(initial.result);
    expect(options!.subtitle).toBe('Ответ получен');
    const refreshed = await options!.load!();
    expect(refreshed.tabs[0]!.text).toBe(current.result);
    expect(options!.actionLabel).toBeUndefined();
    current.deletedAt = '2026-09-12T12:00:00Z';
    expect((await options!.load!()).subtitle).toBe('Скрыта · только чтение');
    return 'back';
  });
  expect(await showTaskAnswer(client(request), initial)).toBe('back');
  expect(request.mock.calls).toEqual([
    ['runtime.status', { runId: 'run' }],
    ['runtime.status', { runId: 'run' }],
  ]);
});

it('удалённый ответ очищается и возвращает к каталогу; потеря связи не считается удалением', async () => {
  const missing = new ResourceNotFoundError('task');
  vi.mocked(readText)
    .mockImplementationOnce(async (_title, _tabs, options) => {
      expect(options!.exitOnError!(new Error('connection lost'))).toBe(false);
      expect(options!.exitOnError!(missing)).toBe(true);
      throw missing;
    })
    .mockImplementationOnce(async (title, tabs) => {
      expect(title).toBe('Задача удалена');
      expect(JSON.stringify(tabs)).not.toContain(initial.result);
      return 'back';
    });
  expect(await showTaskAnswer(client(vi.fn()), initial)).toBe('removed');
});

it('живой экран переходит от ожидания к большому ответу и читает части вперёд и назад', async () => {
  const first = 'Первая часть 🙂\n',
    second = 'Вторая часть. Конец.';
  const waiting = { ...initial, result: undefined, status: 'running' } as StatusView;
  const current = {
    ...initial,
    result: first,
    resultTruncated: true,
    resultLength: first.length + second.length,
  };
  const request = vi.fn(async (method, input) => {
    if (method === 'runtime.status') return current;
    expect(method).toBe('runtime.result');
    expect(input.runId).toBe(initial.runId);
    return input.cursor === 0
      ? {
          text: first,
          cursor: 0,
          nextCursor: first.length,
          total: current.resultLength,
          hasMore: true,
        }
      : {
          text: second,
          cursor: first.length,
          nextCursor: current.resultLength,
          total: current.resultLength,
          hasMore: false,
        };
  });
  vi.mocked(readText)
    .mockImplementationOnce(async (_title, tabs, options) => {
      expect(tabs[0]!.text).toContain('ещё не получен');
      const refreshed = await options!.load!();
      expect(refreshed.notice).toContain('большой ответ');
      expect(refreshed.actionLabel).toContain('по частям');
      return 'action';
    })
    .mockImplementationOnce(async (_title, tabs, options) => {
      expect(tabs[0]!.text).toBe(first);
      expect(options!.notice).toBe('Есть следующая часть');
      return 'action';
    })
    .mockImplementationOnce(async (_title, tabs, options) => {
      expect(tabs[0]!.text).toBe(second);
      expect(options!.notice).toBe('Конец ответа');
      return 'action';
    })
    .mockImplementationOnce(async (_title, tabs) => {
      expect(tabs[0]!.text).toBe(first);
      return 'back';
    });
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options.map((item) => item.value)).toContain('next');
      return 'next';
    })
    .mockImplementationOnce(async (options) => {
      const values = (await options.load()).options.map((item) => item.value);
      expect(values).toContain('previous');
      expect(values).not.toContain('next');
      return 'previous';
    });
  expect(await showTaskAnswer(client(request), waiting)).toBe('back');
  expect(
    request.mock.calls
      .filter(([method]) => method === 'runtime.result')
      .map(([, input]) => input.cursor),
  ).toEqual([0, first.length, 0]);
});
