import { beforeEach, expect, it, vi } from 'vitest';
import { purgeTask } from '../src/interfaces/guided/purge-task.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { Command } from 'commander';
import { registerRunCommands } from '../src/interfaces/commands/run.js';

vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn(), success: vi.fn() },
}));

const status = { runId: 'run', task: 'Моя задача', status: 'completed' } as StatusView;
const preview = {
  sessionId: 'session',
  runIds: ['first', 'run'],
  runs: 2,
  artifacts: 3,
  backups: 1,
  lessons: 2,
  evidence: 4,
  exports: 1,
  available: true,
  blockers: [],
  previewToken: 'reviewed-version',
};
const request = vi.fn();
const context: CliContext = {
  request: request as CliContext['request'],
  directory: () => '/unused',
  interactive: () => true,
  json: () => false,
  output: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  request.mockResolvedValue(structuredClone(preview));
});

it('отказ сохраняет переписку и знания, подтверждение объясняет весь объём удаления', async () => {
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    expect(options.body).toContain('Этапов задачи: 2');
    expect(options.body).toContain('Связанных уроков: 2');
    expect(options.body).toContain('Файлы проекта');
    expect(options.inactive).toBe('Оставить');
    return false;
  });
  expect(await purgeTask(context, status)).toBe(false);
  expect(request).toHaveBeenCalledExactlyOnceWith('runtime.purgePreview', { runId: 'run' });
});

it('изменение состава переписки отключает старое подтверждение', async () => {
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    request.mockResolvedValue({ ...preview, runs: 3, previewToken: 'new-version' });
    const refreshed = await options.load();
    expect(refreshed.available).toBe(false);
    expect(refreshed.detail).toContain('Переписка изменилась');
    return undefined;
  });
  expect(await purgeTask(context, status)).toBe(false);
  expect(request.mock.calls.every(([method]) => method === 'runtime.purgePreview')).toBe(true);
});

it('невозможность удаления объясняется до подтверждения', async () => {
  request.mockResolvedValue({
    ...preview,
    available: false,
    blockers: ['Остановите работающую задачу.'],
  });
  expect(await purgeTask(context, status)).toBe(false);
  expect(liveConfirm).not.toHaveBeenCalled();
  expect(readText).toHaveBeenCalledWith('Удаление пока недоступно', [
    { id: 'reason', label: 'Что нужно сделать', text: 'Остановите работающую задачу.' },
  ]);
});

it('подтверждение передаёт серверу только проверенный состав, без повторного вычисления токена', async () => {
  vi.mocked(liveConfirm).mockResolvedValue(true);
  expect(await purgeTask(context, status)).toBe(true);
  expect(request).toHaveBeenLastCalledWith('runtime.purge', {
    runId: 'run',
    previewToken: 'reviewed-version',
  });
});

it('CLI без подтверждения ничего не удаляет, preview и confirm остаются разными командами', async () => {
  const cli = { ...context, interactive: () => false };
  const invoke = (args: string[]) => {
    const program = new Command();
    registerRunCommands(program, cli);
    return program.parseAsync(args, { from: 'user' });
  };
  await expect(invoke(['purge', 'run'])).rejects.toThrow('--preview');
  expect(request).not.toHaveBeenCalled();
  await invoke(['purge', 'run', '--preview']);
  expect(request).toHaveBeenLastCalledWith('runtime.purgePreview', { runId: 'run' });
  await invoke(['purge', 'run', '--confirm', 'reviewed-version']);
  expect(request).toHaveBeenLastCalledWith('runtime.purge', {
    runId: 'run',
    previewToken: 'reviewed-version',
  });
});
