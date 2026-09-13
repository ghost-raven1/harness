import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';

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
const key = (name: string) => process.stdin.emit('keypress', '', { name });
const options = {
  title: 'Разрешение',
  message: 'Разрешить операцию?',
  body: 'Файл: проверка.txt\nСодержимое: точные данные',
};

it('решение из другого окна обновляет экран и не возвращает ранее выбранное Да', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({ available: true, detail: 'Ожидает решения' })
    .mockResolvedValue({ available: false, detail: 'Операция отменена' });
  const running = liveConfirm({ ...options, load });
  await vi.waitFor(() => expect(drawing.draw).toHaveBeenCalled());
  expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('Enter — подтвердить');
  expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('Esc — назад');
  expect(drawing.draw.mock.calls.at(-1)?.[0]).not.toContain('…');
  key('left');
  await vi.advanceTimersByTimeAsync(1000);
  expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('Решение больше не требуется');
  key('return');
  expect(await running).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(drawing.draw.done).toHaveBeenCalledOnce();
});

it('потеря связи блокирует подтверждение, успешное обновление сохраняет выбор и аргументы', async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce({ available: true, detail: 'Ожидает решения' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ available: true, detail: 'Ожидает решения' });
  let completed = false;
  const running = liveConfirm({ ...options, load }).then((result) => {
    completed = true;
    return result;
  });
  await vi.waitFor(() => expect(drawing.draw).toHaveBeenCalled());
  key('left');
  await vi.advanceTimersByTimeAsync(1000);
  key('return');
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('Нет связи');
  await vi.advanceTimersByTimeAsync(1000);
  expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('точные данные');
  key('return');
  expect(await running).toBe(true);
});

it('в слишком маленьком окне подтверждение недоступно, Esc завершает наблюдение', async () => {
  process.stdout.columns = 20;
  const running = liveConfirm({
    ...options,
    load: async () => ({ available: true, detail: 'Ожидает решения' }),
  });
  await vi.waitFor(() => expect(drawing.draw).toHaveBeenCalled());
  key('left');
  key('return');
  key('escape');
  expect(typeof (await running)).toBe('symbol');
  expect(vi.getTimerCount()).toBe(0);
});
