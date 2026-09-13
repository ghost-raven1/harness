import { beforeEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseTask } from '../src/interfaces/guided/tasks.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { followRun } from '../src/interfaces/guided/watch.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { temporary } from './helpers.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('../src/interfaces/guided/watch.js', () => ({ followRun: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const task: StatusView = {
  runId: 'run',
  sessionId: 'session',
  task: 'Проверочная задача',
  workspace: '/workspace',
  profile: 'fixture',
  status: 'completed',
  turns: 1,
  usage: { input: 1, output: 1 },
  learningVersion: 'baseline',
  agents: [],
  approvals: [],
  unknownInvocations: [],
  cursor: 0,
  events: [],
  result: 'Старый ответ, который нужно убрать с экрана',
};
function client(request: ReturnType<typeof vi.fn>): CliContext {
  return {
    request,
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  } as CliContext;
}

it.each(['menu', 'selection', 'details'] as const)(
  'удаление на этапе %s возвращает каталог без старого содержимого',
  async (stage) => {
    const missing = new ResourceNotFoundError('task');
    let removed = stage === 'menu';
    const request = vi.fn(async () => {
      if (removed) throw missing;
      return task;
    });
    vi.mocked(followRun).mockResolvedValue(task);
    let catalogues = 0;
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      if (options.title === 'Мои задачи') return ++catalogues === 1 ? 'run' : 'back';
      expect(options.exitOnError!(missing)).toBe(true);
      expect(options.exitOnError!(new Error('connection lost'))).toBe(false);
      await options.load();
      if (stage === 'selection') removed = true;
      return stage === 'details' ? 'details' : 'answer';
    });
    vi.mocked(readText).mockImplementation(async (title, tabs, options) => {
      if (title === 'Сведения о задаче') {
        removed = true;
        expect(options!.exitOnError!(missing)).toBe(true);
        expect(options!.exitOnError!(new Error('connection lost'))).toBe(false);
        await options!.load!();
        throw new Error('Удаление должно прервать обновление');
      }
      expect(title).toBe('Задача удалена');
      expect(JSON.stringify(tabs)).not.toContain(task.result);
      return 'back';
    });
    await chooseTask(client(request), task);
    expect(catalogues).toBe(2);
    expect(readText).toHaveBeenCalledTimes(stage === 'details' ? 2 : 1);
  },
);

it('конфликт экспорта показывается в действиях, а чужой файл не объявляется сохранённым', async () => {
  const current = { ...task, workspace: await temporary() };
  await writeFile(join(current.workspace, 'Ответ Harness run.md'), 'Пользовательские заметки');
  vi.mocked(followRun).mockResolvedValue(current);
  const request = vi.fn().mockResolvedValue(current);
  let step = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    if (options.title === 'Мои задачи') return 'run';
    const menu = await options.load();
    if (++step === 1) return 'save';
    expect(menu.summary).toContain('Файл содержит другой текст');
    expect(menu.summary).not.toMatch(/Ответ уже сохранён|Ответ сохранён:/);
    return 'back';
  });
  await chooseTask(client(request), current);
  expect(step).toBe(2);
});

it.each([false, true])(
  'возврат из действий не ждёт новый RPC; скрытая задача: %s',
  async (hidden) => {
    const current = { ...task, ...(hidden ? { deletedAt: '2026-09-12' } : {}) };
    vi.mocked(followRun).mockResolvedValue(current);
    const request = vi
      .fn()
      .mockResolvedValueOnce(current)
      .mockImplementation(() => {
        throw new Error('После выбора «Назад» запросы запрещены');
      });
    let catalogues = 0;
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      if (options.title === 'Мои задачи') return ++catalogues === 1 ? 'run' : 'back';
      await options.load();
      return 'back';
    });
    await chooseTask(client(request), current);
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.status', { runId: 'run' });
    expect(catalogues).toBe(hidden ? 2 : 1);
  },
);
