import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import type { IterationStatus } from '../src/runtime/iterations.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';
import type { CliContext } from '../src/interfaces/types.js';
import { showIterationSettings } from '../src/interfaces/guided/iterations.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText } from '../src/interfaces/guided/text-reader.js';

vi.mock('@clack/prompts', () => ({ text: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('../src/interfaces/guided/screen.js', () => ({ page: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function fixture(run = false) {
  const state: IterationStatus = {
    defaultLimit: 256,
    ...(run
      ? { run: { limit: 5, used: 5, total: 10, remaining: 0, pausedByLimit: true, editable: true } }
      : {}),
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'iterations.configure') {
      const value = params as { limit: number };
      if (state.run) state.run.limit = value.limit;
      else state.defaultLimit = value.limit;
    }
    return structuredClone(state);
  });
  const context = { request } as unknown as CliContext;
  return { state, request, context };
}

function back() {
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    await options.load();
    return 'back';
  });
}

it('новый предел сохраняется после подтверждения с исходным значением и виден в текущем меню', async () => {
  const value = fixture();
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.summary).toContain('Для новых задач: 256 шагов.');
      expect(menu.options).toContainEqual({ value: 'edit', label: 'Изменить предел' });
      return 'edit';
    })
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.summary).toContain('Предел сохранён: 1000001 шагов.');
      expect(menu.summary).toContain('Для новых задач: 1000001 шагов.');
      return 'back';
    });
  vi.mocked(prompts.text).mockImplementationOnce(async (options) => {
    expect(options.initialValue).toBe('256');
    for (const input of ['', '0', '-1', '1.5', 'abc', '1e2', '9007199254740992'])
      expect(await options.validate!(input)).toBeTruthy();
    expect(await options.validate!('1000001')).toBeUndefined();
    expect(await options.validate!('9007199254740991')).toBeUndefined();
    return '1000001';
  });
  vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
    expect(options.body).toContain('Текущие задачи сохранят свои настройки.');
    expect((await options.load()).available).toBe(true);
    expect(value.request.mock.calls.some(([method]) => method === 'iterations.configure')).toBe(
      false,
    );
    return true;
  });
  await showIterationSettings(value.context);
  expect(value.request).toHaveBeenCalledWith('iterations.configure', {
    limit: 1000001,
    expectedLimit: 256,
  });
});

it.each([false, Symbol('cancel')])('отказ или Esc не изменяет настройку: %s', async (answer) => {
  const value = fixture();
  vi.mocked(liveSelect).mockResolvedValueOnce('edit');
  back();
  vi.mocked(prompts.text).mockResolvedValueOnce('12');
  vi.mocked(liveConfirm).mockResolvedValueOnce(answer);
  await showIterationSettings(value.context);
  expect(value.request.mock.calls.map(([method]) => method)).not.toContain('iterations.configure');
});

it('отмена ввода возвращает меню, не открывая подтверждение', async () => {
  const value = fixture();
  vi.mocked(liveSelect).mockResolvedValueOnce('edit');
  back();
  vi.mocked(prompts.text).mockResolvedValueOnce(Symbol('cancel'));
  await showIterationSettings(value.context);
  expect(liveConfirm).not.toHaveBeenCalled();
  expect(value.request.mock.calls.map(([method]) => method)).not.toContain('iterations.configure');
});

it.each([false, true])(
  'изменение из другого окна делает подтверждение недействительным, задача=%s',
  async (run) => {
    const value = fixture(run);
    vi.mocked(liveSelect).mockResolvedValueOnce('edit');
    vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
      expect((await options.load()).summary).toContain('Предел уже изменён в другом окне');
      return 'back';
    });
    vi.mocked(prompts.text).mockResolvedValueOnce('12');
    vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
      expect((await options.load()).available).toBe(true);
      if (value.state.run) value.state.run.limit = 42;
      else value.state.defaultLimit = 42;
      expect(await options.load()).toEqual({
        available: false,
        detail: 'Предел уже изменён в другом окне',
      });
      return true;
    });
    await showIterationSettings(value.context, run ? 'run' : undefined);
    expect(value.request.mock.calls.map(([method]) => method)).not.toContain(
      'iterations.configure',
    );
  },
);

it('задача, продолженная другим клиентом, теряет кнопку изменения и не отправляет настройку', async () => {
  const value = fixture(true);
  vi.mocked(liveSelect).mockResolvedValueOnce('edit');
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('Изменение доступно на паузе');
    expect(menu.options.map((option) => option.value)).toEqual(['details', 'back']);
    return 'back';
  });
  vi.mocked(prompts.text).mockResolvedValueOnce('12');
  vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
    value.state.run!.editable = false;
    expect(await options.load()).toEqual({
      available: false,
      detail: 'Изменение доступно на паузе',
    });
    return true;
  });
  await showIterationSettings(value.context, 'run');
  expect(value.request.mock.calls.map(([method]) => method)).not.toContain('iterations.configure');
});

it('изменение порции при паузе сохраняет точный runId и оставляет историю без вызова resume', async () => {
  const value = fixture(true);
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('В порции: 5 / 5 шагов');
    expect(menu.summary).toContain('Всего выполнено: 10');
    expect(menu.summary).toContain('Достигнут предел. Задача на паузе.');
    return 'edit';
  });
  back();
  vi.mocked(prompts.text).mockResolvedValueOnce('12');
  vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
    expect((await options.load()).available).toBe(true);
    return true;
  });
  await showIterationSettings(value.context, 'run');
  expect(value.request).toHaveBeenCalledWith('iterations.configure', {
    limit: 12,
    expectedLimit: 5,
    runId: 'run',
  });
  expect(value.state.run?.total).toBe(10);
  expect(value.request.mock.calls.map(([method]) => method)).not.toContain('runtime.resume');
});

it('проверяет editable снова перед вводом, если пользователь выбрал уже исчезнувшую кнопку', async () => {
  const value = fixture(true);
  value.state.run!.editable = false;
  vi.mocked(liveSelect).mockResolvedValueOnce('edit');
  back();
  await showIterationSettings(value.context, 'run');
  expect(prompts.text).not.toHaveBeenCalled();
  expect(liveConfirm).not.toHaveBeenCalled();
});

it('удаление при подтверждении очищает старые цифры и возвращает каталог задач', async () => {
  const value = fixture(true);
  vi.mocked(liveSelect).mockResolvedValueOnce('edit');
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    const menu = await options.load();
    expect(menu.message).toBe('Задача удалена');
    expect(menu.summary).not.toContain('5');
    expect(menu.options).toEqual([{ value: 'back', label: '← К списку задач' }]);
    return 'back';
  });
  vi.mocked(prompts.text).mockResolvedValueOnce('12');
  vi.mocked(liveConfirm).mockImplementationOnce(async (options) => {
    value.request.mockRejectedValue(new ResourceNotFoundError('task'));
    expect(await options.load()).toEqual({ available: false, detail: 'Задача удалена' });
    return undefined;
  });
  await expect(showIterationSettings(value.context, 'run')).resolves.toBe('removed');
  expect(value.request.mock.calls.map(([method]) => method)).not.toContain('iterations.configure');
});

it('справка получает свежие счётчики и закрывается при удалении задачи', async () => {
  const value = fixture(true);
  vi.mocked(liveSelect).mockResolvedValueOnce('details');
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    expect((await options.load()).message).toBe('Задача удалена');
    return 'back';
  });
  vi.mocked(readText).mockImplementationOnce(async (_title, tabs, options) => {
    expect(tabs[0]!.text).toContain('Всего выполнено: 10');
    value.state.run!.total = 15;
    expect((await options!.load!()).tabs[0]!.text).toContain('Всего выполнено: 15');
    const error = new ResourceNotFoundError('task');
    expect(options!.exitOnError!(error)).toBe(true);
    throw error;
  });
  await expect(showIterationSettings(value.context, 'run')).resolves.toBe('removed');
});
