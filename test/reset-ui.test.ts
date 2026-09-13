import { beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { confirmDataReset, resetData } from '../src/interfaces/guided/reset-data.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { registerMaintenanceCommands } from '../src/interfaces/commands/maintenance.js';
import type { CliContext } from '../src/interfaces/types.js';
import type { DataResetScope } from '../src/application/data-reset.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));

const request = vi.fn();
const context: CliContext = {
  request: request as CliContext['request'],
  directory: () => '/unused',
  interactive: () => true,
  json: () => false,
  output: vi.fn(),
};
const preview = {
  scope: 'all',
  tasks: 4,
  sessions: 2,
  lessons: 3,
  evidence: 6,
  jobs: 1,
  artifacts: 2,
  backups: 1,
  exports: 0,
  available: true,
  blockers: [],
  previewToken: 'reviewed-content',
};

beforeEach(() => {
  vi.resetAllMocks();
  request.mockResolvedValue(structuredClone(preview));
});

it('состав выбирается отдельно; Esc не запускает очистку', async () => {
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.options.map((option) => option.value)).toEqual([
      'tasks',
      'learning',
      'all',
      'back',
    ]);
    expect(menu.summary).toContain('Настройки и файлы проектов сохранятся');
    return Symbol('cancel');
  });
  await resetData(context);
  expect(request).toHaveBeenCalledExactlyOnceWith('maintenance.resetPreview', { scope: 'all' });
  expect(liveConfirm).not.toHaveBeenCalled();
});

it.each<DataResetScope>(['tasks', 'learning', 'all'])(
  '%s: подтверждение относится только к выбранному составу',
  async (scope) => {
    vi.mocked(liveConfirm).mockImplementation(async (options) => {
      expect(options.inactive).toBe('Оставить');
      expect(options.body).toContain('Настройки, подключения и файлы проектов сохранятся');
      if (scope === 'tasks')
        expect(options.body).toContain('Доказательства могут содержать фрагменты');
      if (scope === 'learning') expect(options.body).toContain('История задач сохранится');
      return true;
    });
    expect(await confirmDataReset(context, scope)).toBe(true);
    expect(request).toHaveBeenLastCalledWith('maintenance.reset', {
      scope,
      previewToken: 'reviewed-content',
    });
  },
);

it('новые данные из другого окна отключают прежнее подтверждение', async () => {
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    request.mockResolvedValue({ ...preview, previewToken: 'changed-content' });
    expect(await options.load()).toMatchObject({ available: false });
    return undefined;
  });
  expect(await confirmDataReset(context, 'all')).toBe(false);
  expect(request.mock.calls.every(([method]) => method === 'maintenance.resetPreview')).toBe(true);
});

it('экран блокировки обновляется, но снятие блокировки само не удаляет данные', async () => {
  request.mockResolvedValue({ ...preview, available: false, blockers: ['Задача ещё работает.'] });
  vi.mocked(readText).mockImplementation(async (_title, tabs, options) => {
    expect(tabs[0]?.text).toContain('Задача ещё работает');
    request.mockResolvedValue(preview);
    expect((await options!.load!()).tabs[0]?.text).toContain('выберите состав заново');
    return 'back';
  });
  expect(await confirmDataReset(context, 'all')).toBe(false);
  expect(liveConfirm).not.toHaveBeenCalled();
});

it('ошибка сервиса не показывается как успешный сброс', async () => {
  vi.mocked(liveConfirm).mockResolvedValue(true);
  request.mockImplementation(async (method) => {
    if (method === 'maintenance.reset') throw new Error('Состав изменился');
    return preview;
  });
  expect(await confirmDataReset(context, 'tasks')).toBe(false);
  expect(readText).toHaveBeenCalledWith('Очистка не выполнена', [
    expect.objectContaining({ text: expect.stringContaining('Состав изменился') }),
  ]);
});

it('CLI требует явные scope и preview/confirm; неизвестный состав не отправляется сервису', async () => {
  const invoke = (args: string[]) => {
    const program = new Command();
    registerMaintenanceCommands(program, { ...context, interactive: () => false });
    return program.parseAsync(args, { from: 'user' });
  };
  await expect(invoke(['reset'])).rejects.toThrow('--preview');
  await expect(invoke(['reset', '--confirm', 'token'])).rejects.toThrow('--scope');
  await expect(invoke(['reset', '--scope', 'workspace', '--preview'])).rejects.toThrow(
    'Выберите состав',
  );
  await expect(
    invoke(['reset', '--scope', 'all', '--preview', '--confirm', 'token']),
  ).rejects.toThrow('не оба');
  expect(request).not.toHaveBeenCalled();
  await invoke(['reset', '--scope', 'tasks', '--preview']);
  expect(request).toHaveBeenLastCalledWith('maintenance.resetPreview', { scope: 'tasks' });
  await invoke(['reset', '--scope', 'tasks', '--confirm', 'reviewed-content']);
  expect(request).toHaveBeenLastCalledWith('maintenance.reset', {
    scope: 'tasks',
    previewToken: 'reviewed-content',
  });
});
