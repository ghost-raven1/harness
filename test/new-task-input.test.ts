import { beforeEach, expect, it, vi } from 'vitest';
import { prepareTask } from '../src/interfaces/guided/new-task.js';
import { readTaskInput } from '../src/interfaces/guided/task-input.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { dispatch } from '../src/interfaces/routes.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { inputApplication } from './task-input-fixture.js';
import { ScriptedProvider, output } from './helpers.js';

vi.mock('../src/interfaces/guided/task-input.js', () => ({ readTaskInput: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

function client(
  request: (method: string, params: unknown) => Promise<unknown>,
  interactive = true,
): CliContext {
  return {
    request: request as CliContext['request'],
    interactive: () => interactive,
    directory: () => '/unused',
    json: () => false,
    output: vi.fn(),
  };
}

it('многострочный текст передаётся без trim и сохраняется до подтверждения отправки', async () => {
  const app = await inputApplication();
  const text = '  Первая строка\n\nВторая строка\n';
  vi.mocked(readTaskInput).mockImplementation(async (options) => {
    await options.save(text);
    return text;
  });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.run') {
      const scope = { workspace: app.workspace, profile: 'test' };
      const page = await app.drafts.list(scope);
      expect(page.items[0]?.state).toBe('pending');
      expect((await app.drafts.get({ id: page.items[0]!.id })).text).toBe(text);
    }
    return dispatch(app, method, params);
  });
  const result = await prepareTask(client(request), {
    scope: { workspace: app.workspace, profile: 'test' },
  });
  await app.runtime.wait(result.runId);
  expect(
    app.sessions.get(result.runId).agents[app.sessions.get(result.runId).rootAgentId]?.task,
  ).toBe(text);
  expect((await app.drafts.list({ workspace: app.workspace, profile: 'test' })).total).toBe(0);
});

it('потерянный ACK после принятия задачи повторяет тот же ключ и не создаёт второй запуск', async () => {
  const provider = new ScriptedProvider(() => output('Один ответ'));
  const app = await inputApplication(provider);
  let lost = true;
  const keys: string[] = [];
  const request = async (method: string, params: unknown) => {
    const result = await dispatch(app, method, params);
    if (method === 'runtime.run') {
      keys.push((params as { requestKey: string }).requestKey);
      if (lost) {
        lost = false;
        throw new Error('Local service closed the connection before completion');
      }
    }
    return result;
  };
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    expect(options.title).toBe('Запрос не подтверждён');
    expect((await options.load()).options[0]?.label).toBe('Повторить отправку');
    return 'retry';
  });
  const result = await prepareTask(client(request), {
    scope: { workspace: app.workspace, profile: 'test' },
    text: 'Сохрани один запрос',
  });
  await app.runtime.wait(result.runId);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(app.sessions.list()).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
});

it('повтор неинтерактивной команды после обрыва находит тот же неподтверждённый запрос', async () => {
  const app = await inputApplication();
  const scope = { workspace: app.workspace, profile: 'test' };
  const request = async (method: string, params: unknown) => {
    if (method === 'runtime.run') throw new Error('Connection lost');
    return dispatch(app, method, params);
  };
  await expect(
    prepareTask(client(request, false), { scope, text: 'Длинный\nтекст' }),
  ).rejects.toThrow('ключ сохранены');
  const saved = (await app.drafts.list(scope)).items[0]!;
  const result = await prepareTask(
    client((method, params) => dispatch(app, method, params), false),
    { scope, text: 'Длинный\nтекст' },
  );
  await app.runtime.wait(result.runId);
  expect(app.sessions.get(result.runId).requestKey).toBe(saved.requestKey);
  expect((await app.drafts.list(scope)).total).toBe(0);
});

it('Esc сохраняет черновик; следующий вход предлагает восстановление полного текста', async () => {
  const app = await inputApplication();
  const scope = { workspace: app.workspace, profile: 'test' };
  const context = client((method, params) => dispatch(app, method, params));
  const text = 'Мой длинный текст\nСледующий абзац';
  vi.mocked(readTaskInput).mockImplementationOnce(async (options) => {
    await options.save(text);
    return Symbol('cancel');
  });
  await expect(prepareTask(context, { scope })).rejects.toThrow('INTERACTIVE_CANCEL');
  const saved = (await app.drafts.list(scope)).items[0]!;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    if (options.title === 'Сохранённые черновики') return menu.options[0]!.value;
    return 'restore';
  });
  vi.mocked(readTaskInput).mockImplementationOnce(async (options) => {
    expect(options.initialValue).toBe(text);
    return text;
  });
  const result = await prepareTask(context, { scope });
  await app.runtime.wait(result.runId);
  expect(app.sessions.get(result.runId).requestKey).toBe(saved.requestKey);
});

it('слишком длинный или пустой готовый текст отклоняется до обращения к сервису', async () => {
  const request = vi.fn();
  for (const text of ['', '   ', 'x'.repeat(100001)])
    await expect(
      prepareTask(client(request), { scope: { workspace: '/tmp' }, text }),
    ).rejects.toThrow('100 000');
  expect(request).not.toHaveBeenCalled();
});

it('известный отказ устаревшей беседы переносит текст только после подтверждения последнего ответа', async () => {
  const app = await inputApplication(
    new ScriptedProvider((_, index) => output('Ответ ' + (index + 1))),
  );
  const first = await app.runtime.start({
    workspace: app.workspace,
    profile: 'test',
    message: 'Исходная задача',
    requestKey: 'first',
  });
  await app.runtime.wait(first.runId);
  const previous = (await dispatch(app, 'runtime.status', { runId: first.runId })) as StatusView;
  const latest = await app.runtime.start({
    workspace: app.workspace,
    profile: 'test',
    sessionId: first.sessionId,
    expectedParentRunId: first.runId,
    message: 'Другое окно',
    requestKey: 'second',
  });
  await app.runtime.wait(latest.runId);
  vi.mocked(readTaskInput)
    .mockImplementationOnce(async (options) => {
      await options.save('Моё уточнение');
      return 'Моё уточнение';
    })
    .mockImplementationOnce(async (options) => {
      expect(options.initialValue).toBe('Моё уточнение');
      await options.save('Моё уточнение\nС учётом последнего ответа');
      return 'Моё уточнение\nС учётом последнего ответа';
    });
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    expect(options.title).toBe('В беседе появился новый ответ');
    expect(options.body).toContain('Ответ 2');
    expect((await options.load()).available).toBe(true);
    return true;
  });
  const requests: Array<{ requestKey: string; expectedParentRunId: string }> = [];
  const result = await prepareTask(
    client(async (method, params) => {
      if (method === 'runtime.run') requests.push(params as (typeof requests)[number]);
      return dispatch(app, method, params);
    }),
    {
      scope: {
        workspace: app.workspace,
        profile: 'test',
        sessionId: first.sessionId,
        expectedParentRunId: first.runId,
      },
      previous,
    },
  );
  await app.runtime.wait(result.runId);
  expect(app.sessions.list()).toHaveLength(3);
  expect(requests).toHaveLength(2);
  expect(requests[1]?.expectedParentRunId).toBe(latest.runId);
  expect(requests[0]?.requestKey).not.toBe(requests[1]?.requestKey);
  expect(app.sessions.get(result.runId).sessionId).toBe(first.sessionId);
});
