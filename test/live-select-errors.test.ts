import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { isMissingResource, ResourceNotFoundError } from '../src/shared/resource-errors.js';

const drawing = vi.hoisted(() => ({ draw: Object.assign(vi.fn(), { done: vi.fn() }) }));
vi.mock('log-update', () => ({ createLogUpdate: () => drawing.draw }));
const original = {
  stdin: process.stdin.isTTY,
  stdout: process.stdout.isTTY,
  raw: process.stdin.setRawMode,
  columns: process.stdout.columns,
  rows: process.stdout.rows,
  term: process.env.TERM,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  process.stdin.isTTY = process.stdout.isTTY = true;
  process.stdin.setRawMode = vi.fn(() => process.stdin);
  process.stdout.columns = 48;
  process.stdout.rows = 24;
  process.env.TERM = 'xterm';
});
afterEach(() => {
  process.stdin.isTTY = original.stdin;
  process.stdout.isTTY = original.stdout;
  process.stdin.setRawMode = original.raw;
  process.stdout.columns = original.columns;
  process.stdout.rows = original.rows;
  if (original.term === undefined) delete process.env.TERM;
  else process.env.TERM = original.term;
  vi.useRealTimers();
});
const menu = { message: 'Что дальше?', options: [{ value: 'answer', label: 'Прочитать ответ' }] };
const options = {
  title: 'Задача',
  exitOnError: (error: unknown) => isMissingResource(error, 'task'),
};

it('удаление до первого кадра передаёт владельцу причину вместо экрана переподключения', async () => {
  const missing = new ResourceNotFoundError('task');
  await expect(
    liveSelect({
      ...options,
      load: async () => {
        throw missing;
      },
    }),
  ).rejects.toBe(missing);
  expect(drawing.draw).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('удаление открытого меню завершает опрос и обработчики, не показывая потерю связи', async () => {
  const missing = new ResourceNotFoundError('task');
  const load = vi.fn().mockResolvedValueOnce(menu).mockRejectedValue(missing);
  const keyListeners = process.stdin.listenerCount('keypress');
  const running = liveSelect({ ...options, load });
  const failure = expect(running).rejects.toBe(missing);
  await vi.waitFor(() => expect(drawing.draw).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1000);
  await failure;
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(process.stdin.listenerCount('keypress')).toBe(keyListeners);
  expect(drawing.draw.done).toHaveBeenCalledOnce();
  expect(drawing.draw.mock.calls.flat().join('\n')).not.toContain('Нет связи');
});

it('обычный разрыв связи сохраняет переподключение и актуальный выбор после восстановления', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce(menu)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(menu);
  const running = liveSelect({ ...options, load });
  await vi.waitFor(() => expect(drawing.draw).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1000);
  expect(drawing.draw.mock.calls.at(-1)![0]).toContain('Нет связи');
  await vi.advanceTimersByTimeAsync(1000);
  expect(drawing.draw.mock.calls.at(-1)![0]).not.toContain('Нет связи');
  process.stdin.emit('keypress', '', { name: 'return' });
  expect(await running).toBe('answer');
  expect(vi.getTimerCount()).toBe(0);
});
