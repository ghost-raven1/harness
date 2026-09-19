import { expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dispatch } from '../src/interfaces/routes.js';
import { createApplication } from '../src/interfaces/application.js';
import { queryHistory } from '../src/sessions/history.js';
import { chooseTask } from '../src/interfaces/guided/tasks.js';
import { followRun } from '../src/interfaces/guided/watch.js';
import type { CliContext, TaskView } from '../src/interfaces/types.js';
import { ScriptedProvider, cleanup, configDirectory, output, temporary } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function archive() {
  const root = await temporary();
  const app = Object.assign(
    await createApplication(
      await configDirectory(root, 'http://127.0.0.1:1/v1'),
      join(root, 'state'),
      new ScriptedProvider(() => output('Полный ответ: секретный ключ поиска')),
    ),
    { workspace: join(root, 'workspace') },
  );
  cleanup(() => app.close());
  const hidden = await app.runtime.start({
    message: 'Скрытая проверка',
    workspace: app.workspace,
    requestKey: 'hidden',
  });
  await app.runtime.wait(hidden.runId);
  await app.sessions.delete(hidden.runId);
  const visible = await app.runtime.start({
    message: 'Обычная проверка',
    workspace: app.workspace,
    requestKey: 'visible',
  });
  await app.runtime.wait(visible.runId);
  return { app, hidden, visible };
}

it('скрытые задачи доступны только по явному флагу и находятся по сохранённому ответу', async () => {
  const { app, hidden, visible } = await archive();
  const normal = (await dispatch(app, 'runtime.history', {})) as ReturnType<typeof queryHistory>;
  expect(normal.total).toBe(1);
  expect(normal.items.map((row) => row.runId)).toEqual([visible.runId]);
  const all = (await dispatch(app, 'runtime.history', { includeDeleted: true })) as ReturnType<
    typeof queryHistory
  >;
  expect(all.total).toBe(2);
  expect(all.items.find((row) => row.runId === hidden.runId)?.deletedAt).toBeDefined();
  const found = (await dispatch(app, 'runtime.history', {
    includeDeleted: true,
    query: 'СЕКРЕТНЫЙ КЛЮЧ',
  })) as ReturnType<typeof queryHistory>;
  expect(found.items.map((row) => row.runId)).toContain(hidden.runId);
  await expect(dispatch(app, 'runtime.history', { includeDeleted: 'yes' })).rejects.toThrow();
});

it('архив выдаёт все страницы без пропусков, поиск и переключение режима сбрасывают страницу', async () => {
  const { app, hidden } = await archive();
  const source = app.sessions.get(hidden.runId);
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...structuredClone(source),
    id: randomUUID(),
    deletedAt: index % 2 ? undefined : source.deletedAt,
    result: index === 0 ? 'Уникальный ответ' : 'Обычный ответ',
  }));
  const pages = Array.from({ length: 4 }, (_, index) => queryHistory(records, '', index, 10));
  expect(pages.map((value) => value.items.length)).toEqual([10, 10, 10, 5]);
  expect(pages.every((value) => value.total === 35)).toBe(true);
  expect(new Set(pages.flatMap((value) => value.items.map((item) => item.runId))).size).toBe(35);
  const request = vi.fn(async (_method: string, params: unknown) => {
    const args = params as { page: number; query: string; includeDeleted: boolean };
    return queryHistory(
      args.includeDeleted ? records : records.filter((row) => !row.deletedAt),
      args.query,
      args.page,
    );
  });
  vi.mocked(prompts.select)
    .mockResolvedValueOnce('next')
    .mockResolvedValueOnce('search')
    .mockResolvedValueOnce('hidden')
    .mockResolvedValueOnce('clear')
    .mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce('Уникальный');
  await chooseTask(
    {
      request: request as CliContext['request'],
      interactive: () => false,
      directory: () => '',
      json: () => false,
      output: vi.fn(),
    },
    { workspace: app.workspace, profile: 'test' },
  );
  expect(request.mock.calls.map(([, args]) => args)).toEqual([
    { page: 0, query: '', includeDeleted: false },
    { page: 0, query: '', includeDeleted: false },
    { page: 1, query: '', includeDeleted: false },
    { page: 0, query: 'Уникальный', includeDeleted: false },
    { page: 0, query: 'Уникальный', includeDeleted: true },
    { page: 0, query: '', includeDeleted: true },
  ]);
  expect(vi.mocked(prompts.select).mock.calls.at(-1)?.[0].message).toContain('всего 35');
  vi.mocked(prompts.select).mockClear();
});

it('скрытую задачу можно прочитать и экспортировать, меню не предлагает изменения', async () => {
  const { app, hidden } = await archive();
  const request = vi.fn((method: string, params?: unknown) => dispatch(app, method, params));
  const events = (await app.sessions.history(hidden.runId, 0)).length;
  vi.mocked(prompts.select).mockClear();
  vi.mocked(prompts.select)
    .mockResolvedValueOnce('hidden')
    .mockResolvedValueOnce(hidden.runId)
    .mockResolvedValueOnce('save')
    .mockResolvedValueOnce('back')
    .mockResolvedValueOnce('back');
  await chooseTask(
    {
      request: request as CliContext['request'],
      interactive: () => false,
      directory: () => app.sessions.directory,
      json: () => false,
      output: vi.fn(),
    },
    { workspace: app.workspace, profile: 'test' },
  );
  const menus = vi.mocked(prompts.select).mock.calls.map(([value]) => value);
  expect(
    menus
      .find((menu) => menu.options.some((item) => item.value === hidden.runId))
      ?.options.find((item) => item.value === hidden.runId)?.label,
  ).toContain('[скрыта]');
  for (const menu of menus.filter((value) => value.message === 'Что дальше?'))
    expect(menu.options.map((item) => item.value)).toEqual([
      'answer',
      'save',
      'details',
      'history',
      'purge',
      'back',
    ]);
  expect(new Set(request.mock.calls.map(([method]) => method))).toEqual(
    new Set(['runtime.history', 'runtime.task', 'runtime.status']),
  );
  expect(await readFile(join(app.workspace, 'Ответ Harness ' + hidden.runId + '.md'), 'utf8')).toBe(
    'Полный ответ: секретный ключ поиска\n',
  );
  expect(await app.sessions.history(hidden.runId, 0)).toHaveLength(events);
  expect(app.sessions.get(hidden.runId).deletedAt).toBeDefined();
});

it('Ctrl+C при чтении скрытой задачи не посылает команду остановки', async () => {
  const { app, hidden } = await archive();
  const status = (await dispatch(app, 'runtime.task', { runId: hidden.runId })) as TaskView;
  const isTTY = process.stdin.isTTY,
    setRawMode = process.stdin.setRawMode;
  const request = vi.fn(async () => {
    process.stdin.emit('keypress', '\u0003', { ctrl: true, name: 'c' });
    return status;
  });
  try {
    process.stdin.isTTY = true;
    process.stdin.setRawMode = vi.fn(() => process.stdin);
    const result = await followRun(
      {
        request: request as CliContext['request'],
        interactive: () => true,
        directory: () => app.sessions.directory,
        json: () => false,
        output: vi.fn(),
      },
      hidden.runId,
      { inspect: true },
    );
    expect(result?.deletedAt).toBeDefined();
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.task', {
      runId: hidden.runId,
      cursor: 0,
      outputCursor: 0,
    });
  } finally {
    process.stdin.isTTY = isTTY;
    process.stdin.setRawMode = setRawMode;
  }
});
