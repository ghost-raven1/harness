import { afterEach, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { startRefresh } from '../src/interfaces/guided/live-refresh.js';
import { MenuSelection, menuFrame } from '../src/interfaces/guided/live-select.js';
import { selected } from '../src/interfaces/ui.js';
import { learningVersionLabel } from '../src/interfaces/guided/learning-labels.js';

afterEach(() => vi.useRealTimers());

const beginnerOptions = [
  { value: 'run', label: 'Новая задача', hint: 'опишите, что нужно сделать' },
  { value: 'tasks', label: 'Мои задачи', hint: 'ответы, продолжение и разрешения' },
  { value: 'settings', label: 'Настройки' },
  { value: 'help', label: 'Как пользоваться', hint: 'примеры и подсказки' },
  { value: 'knowledge', label: 'База знаний', hint: 'уроки, доказательства и проверки' },
  { value: 'exit', label: 'Выход' },
];

it.each([48, 80, 120])(
  'подсказки меню используют доступную ширину %s без потери текста',
  (width) => {
    const text = stripVTControlCharacters(
      menuFrame(
        'Главное меню',
        {
          message: 'Чем займёмся?',
          options: beginnerOptions,
        },
        'run',
        width,
        24,
      ),
    );
    const content = text.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    for (const option of beginnerOptions) {
      expect(content).toContain(option.label);
      if (option.hint) expect(content).toContain(option.hint);
    }
    expect(text).not.toMatch(/…|Обновляется автоматически|1 \/ 6/);
    expect(text.split('\n').every((line) => stringWidth(line) <= width)).toBe(true);
  },
);

it('начальная версия знаний объясняется без внутреннего baseline', () => {
  expect(learningVersionLabel('baseline')).toBe('Без накопленного опыта');
  expect(learningVersionLabel('release-123456')).toBe('Выпуск release-');
});

it('отмена собственного экрана распознаётся без внутреннего символа Clack', () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    expect(() => selected(Symbol('cancel'))).toThrow('INTERACTIVE_CANCEL');
    expect(selected('back')).toBe('back');
  } finally {
    write.mockRestore();
  }
});

it('медленный запрос не создаёт очередь; уход игнорирует его поздний результат', async () => {
  vi.useFakeTimers();
  let finish!: (value: number) => void;
  const load = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const apply = vi.fn();
  const stop = startRefresh(load, apply, vi.fn());
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledOnce();
  stop();
  finish(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(apply).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('разрыв связи не останавливает обновление, следующий успешный снимок применяется', async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(2);
  const apply = vi.fn(),
    error = vi.fn();
  const stop = startRefresh(load, apply, error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(error).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(apply).toHaveBeenCalledWith(2);
  stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(load).toHaveBeenCalledTimes(2);
});

it('перестановка сохраняет выбранную запись, удаление требует нового выбора', () => {
  const a = { value: 'a', label: 'Задача А' },
    b = { value: 'b', label: 'Задача Б' };
  const selection = new MenuSelection('b');
  selection.update([a, b], true);
  selection.update([b, a]);
  expect(selection.value).toBe('b');
  selection.update([a]);
  expect(selection.value).toBeUndefined();
  selection.move([a], 1);
  expect(selection.value).toBe('a');
});

it.each([
  [48, 24],
  [90, 30],
  [120, 40],
])('живое меню сохраняет рамки и управление при %sx%s', (width, height) => {
  const text = stripVTControlCharacters(
    menuFrame(
      'Мои задачи',
      {
        message: 'Выберите задачу',
        summary: 'Папка: /Очень длинный путь/日本語/📚'.repeat(20),
        options: Array.from({ length: 30 }, (_, index) => ({
          value: index,
          label: 'Задача ' + index,
          hint: 'В работе',
        })),
      },
      20,
      width,
      height,
      'offline',
    ),
  );
  const lines = text.split('\n');
  expect(lines.length).toBeLessThan(height);
  expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
  expect(text).toContain('● Задача 20');
  expect(text).toContain('Нет связи');
  expect(text).toContain('Esc — назад');
  expect(text).toContain('ещё пункты');
});
