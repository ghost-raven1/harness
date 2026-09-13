import { beforeEach, expect, it, vi } from 'vitest';
import { link, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileDiagnosticLog } from '../src/diagnostics/file-log.js';
import { observeCommand } from '../src/diagnostics/observe-command.js';
import type { DiagnosticEvent } from '../src/diagnostics/types.js';
import { showDiagnostics } from '../src/interfaces/guided/diagnostics.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import type { CliContext } from '../src/interfaces/types.js';
import { temporary } from './helpers.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('по умолчанию файл не пишется; включение и выключение сохраняются после перезапуска', async () => {
  const directory = await temporary();
  const log = new FileDiagnosticLog(directory);
  await log.initialize();
  expect(log.status().enabled).toBe(false);
  await log.record({ type: 'service.started' });
  await expect(readFile(log.file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await log.setEnabled(true)).enabled).toBe(true);
  await log.record({ type: 'service.started' });
  await log.close();
  const previous = await readFile(log.file, 'utf8');
  await log.record({ type: 'service.stopped' });
  expect(await readFile(log.file, 'utf8')).toBe(previous);

  const reopened = new FileDiagnosticLog(directory);
  await reopened.initialize();
  expect(reopened.status().enabled).toBe(true);
  await reopened.record({ type: 'service.stopped' });
  await reopened.flush();
  expect((await readFile(reopened.file, 'utf8')).trim().split('\n')).toHaveLength(2);
  await reopened.setEnabled(false);
  const disabled = await readFile(reopened.file, 'utf8');
  await reopened.record({ type: 'service.started' });
  expect(await readFile(reopened.file, 'utf8')).toBe(disabled);
  await reopened.close();
  const disabledAfterRestart = new FileDiagnosticLog(directory);
  await disabledAfterRestart.initialize();
  expect(disabledAfterRestart.status().enabled).toBe(false);
  if (process.platform !== 'win32') expect((await stat(log.file)).mode & 0o777).toBe(0o600);
});

it('ротация оставляет три ограниченных файла с последними событиями', async () => {
  const log = new FileDiagnosticLog(await temporary(), { maxBytes: 256 });
  await log.initialize();
  await log.setEnabled(true);
  for (let index = 0; index < 30; index++)
    await log.record({ type: 'command.succeeded', method: 'runtime.run', durationMs: index });
  await log.flush();
  expect((await readdir(log.directory)).sort()).toEqual([
    'harness.1.jsonl',
    'harness.2.jsonl',
    'harness.jsonl',
  ]);
  const remaining = [];
  for (const name of ['harness.2.jsonl', 'harness.1.jsonl', 'harness.jsonl']) {
    const path = join(log.directory, name);
    expect((await stat(path)).size).toBeLessThanOrEqual(256);
    remaining.push(
      ...(await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
  }
  expect(remaining[0].durationMs).toBeGreaterThan(0);
  expect(remaining.at(-1).durationMs).toBe(29);
  expect(remaining.map((event) => event.durationMs)).toEqual(
    [...remaining.map((event) => event.durationMs)].sort((a, b) => a - b),
  );
});

it('исход задачи сохраняет только проверенный UUID и состояние', async () => {
  const log = new FileDiagnosticLog(await temporary());
  await log.initialize();
  await log.setEnabled(true);
  const runId = randomUUID();
  await log.record({
    type: 'task.finished',
    runId,
    status: 'failed',
    task: 'Скрытый текст',
    error: 'Скрытая ошибка',
  } as DiagnosticEvent);
  await log.record({ type: 'task.finished', runId: 'Скрытый текст', status: 'failed' });
  const events = (await readFile(log.file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events).toEqual([
    { at: expect.any(String), type: 'task.finished', runId, status: 'failed' },
  ]);
});

it.each(['runtime.run', 'runtime.message'])(
  'лог %s не сохраняет содержимое запросов и ошибок; успешные опросы пропускаются',
  async (method) => {
    const log = new FileDiagnosticLog(await temporary());
    await log.initialize();
    await log.setEnabled(true);
    const secret = 'fixture-secret-that-must-not-be-written';
    await log.record({
      type: 'command.succeeded',
      method: secret,
      durationMs: 5,
      task: secret,
      args: { apiKey: secret },
      result: secret,
      env: secret,
      stderr: secret,
    } as DiagnosticEvent);
    await log.record({ type: secret } as unknown as DiagnosticEvent);
    const result = { token: secret, text: secret };
    expect(await observeCommand(log, method, async () => result)).toBe(result);
    await observeCommand(log, 'runtime.status', async () => result);
    await observeCommand(log, 'diagnostics.status', async () => result);
    const error = Object.assign(new Error(secret), { code: secret });
    await expect(
      observeCommand(log, secret, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const contents = await readFile(log.file, 'utf8');
    expect(contents).not.toContain(secret);
    const events = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.method)).toEqual(['unknown', method, 'unknown']);
    expect(events.at(-1).code).toBe('COMMAND_FAILED');
    for (const event of events)
      expect(
        Object.keys(event).every((key) =>
          ['at', 'type', 'method', 'durationMs', 'code'].includes(key),
        ),
      ).toBe(true);
  },
);

it
  .skipIf(process.platform === 'win32')
  .each(['root', 'directory', 'file', 'rotation', 'settings', 'hardlink'])(
  'путь %s не позволяет записать диагностический лог во внешний файл через ссылку',
  async (kind) => {
    const base = await temporary();
    const outside = join(base, 'outside');
    await mkdir(outside);
    const externalFile = join(outside, 'existing.txt');
    await writeFile(externalFile, 'Существующий внешний файл');
    const state = join(base, 'state');
    if (kind === 'root') await symlink(outside, state);
    else {
      await mkdir(state);
      if (kind === 'directory') await symlink(outside, join(state, 'logs'));
      else if (kind === 'settings') await symlink(externalFile, join(state, 'diagnostics.json'));
      else {
        await mkdir(join(state, 'logs'));
        const path = join(state, 'logs', kind === 'rotation' ? 'harness.1.jsonl' : 'harness.jsonl');
        if (kind === 'hardlink') await link(externalFile, path);
        else await symlink(externalFile, path);
      }
    }
    const log = new FileDiagnosticLog(state);
    await expect(log.initialize()).resolves.toBeUndefined();
    await expect(log.setEnabled(true)).resolves.toMatchObject({
      enabled: false,
      error: expect.any(String),
    });
    await expect(log.record({ type: 'service.started' })).resolves.toBeUndefined();
    expect(await readFile(externalFile, 'utf8')).toBe('Существующий внешний файл');
    expect(await readdir(outside)).toEqual(['existing.txt']);
  },
);

it('ошибка записи видна в статусе и не меняет исход команды; после исправления запись восстанавливается', async () => {
  const log = new FileDiagnosticLog(await temporary());
  await log.initialize();
  await log.setEnabled(true);
  await mkdir(log.file);
  expect(await observeCommand(log, 'runtime.run', async () => 'Задача выполнена')).toBe(
    'Задача выполнена',
  );
  expect(log.status()).toMatchObject({ enabled: true, error: expect.any(String) });
  const original = new Error('Ошибка самой команды');
  await expect(
    observeCommand(log, 'runtime.run', async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await rm(log.file, { recursive: true });
  await log.record({ type: 'service.started' });
  expect(log.status().error).toBeUndefined();
  expect(await readFile(log.file, 'utf8')).toContain('service.started');
});

it('экран обновляет состояние и отправляет явное включение, а подробности показывают полный путь', async () => {
  const state = {
    enabled: false,
    file: '/private/state/logs/harness.jsonl',
    directory: '/private/state/logs',
    maxBytes: 1024 * 1024,
    retainedFiles: 3,
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === 'diagnostics.configure')
      state.enabled = (params as { enabled: boolean }).enabled;
    return structuredClone(state);
  });
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).summary).toContain('Выключена');
      return 'enable';
    })
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.summary).toContain('Включена');
      expect(menu.summary).toContain('Без текстов задач, ответов и ключей.');
      return 'details';
    })
    .mockResolvedValueOnce('back');
  vi.mocked(readText).mockImplementationOnce(async (_title, tabs, options) => {
    expect(tabs[0]!.text).toContain(state.file);
    state.enabled = false;
    expect((await options!.load!()).tabs[0]!.text).toContain('Запись выключена.');
    return 'back';
  });
  await showDiagnostics({
    request: request as CliContext['request'],
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  });
  expect(request).toHaveBeenCalledWith('diagnostics.configure', { enabled: true });
});
