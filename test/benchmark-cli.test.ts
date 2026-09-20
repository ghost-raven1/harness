import { Command } from 'commander';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { registerBenchmarkCommands } from '../src/interfaces/commands/benchmark.js';
import { runSpecialistBenchmark } from '../src/benchmark/runner.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import type { BenchmarkReport } from '../src/benchmark/types.js';
import type { CliContext } from '../src/interfaces/types.js';
import { configDirectory, temporary } from './helpers.js';

vi.mock('../src/benchmark/runner.js', async (original) => ({
  ...(await original<typeof import('../src/benchmark/runner.js')>()),
  runSpecialistBenchmark: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runSpecialistBenchmark).mockReset();
  vi.mocked(liveConfirm).mockReset();
});

/** Изолирует проверку CLI от сетевых запросов и пользовательского сервиса. */
function command(interactive = false) {
  const context: CliContext = {
    directory: () => '/ordinary-state',
    json: () => true,
    interactive: () => interactive,
    output: vi.fn(),
    request: vi.fn() as unknown as CliContext['request'],
  };
  const cli = new Command();
  registerBenchmarkCommands(cli, context);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return { cli, context };
}

test('реальный CLI показывает 45 запусков и отказывает без явного подтверждения до создания папки', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const { cli, context } = command();
  await expect(
    cli.parseAsync([
      'node',
      'harness',
      'benchmark',
      'specialists',
      '--real',
      '--config',
      config,
      '--profile',
      'test',
      '--output',
      join(root, 'results'),
    ]),
  ).rejects.toThrow('--confirm-real');
  expect(runSpecialistBenchmark).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining('45 отдельных запусков'),
  );
  await expect(access(join(root, 'results'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('отказ в интерактивной форме не вызывает модель или стенд', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const { cli } = command(true);
  vi.mocked(liveConfirm).mockResolvedValue(false);
  await cli.parseAsync([
    'node',
    'harness',
    'benchmark',
    'specialists',
    '--real',
    '--config',
    config,
    '--profile',
    'test',
  ]);
  expect(liveConfirm).toHaveBeenCalledWith(
    expect.objectContaining({ body: expect.stringContaining('verify.mjs') }),
  );
  expect(runSpecialistBenchmark).not.toHaveBeenCalled();
});

test('явное подтверждение передаёт закреплённый профиль, не подключаясь к обычному сервису', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const { cli, context } = command();
  vi.mocked(runSpecialistBenchmark).mockResolvedValue({
    directory: join(root, 'results'),
    report: { status: 'completed', planned: 45, results: [] } as unknown as BenchmarkReport,
  });
  await cli.parseAsync([
    'node',
    'harness',
    'benchmark',
    'specialists',
    '--real',
    '--config',
    config,
    '--profile',
    'test',
    '--confirm-real',
    '--output',
    join(root, 'results'),
  ]);
  expect(runSpecialistBenchmark).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmedReal: true,
      selection: expect.objectContaining({
        kind: 'profile',
        profileId: 'test',
        profile: expect.objectContaining({ model: 'test' }),
      }),
    }),
  );
  expect(context.request).not.toHaveBeenCalled();
});
