import { beforeEach, expect, it, vi } from 'vitest';
import { writeTaskMessage, canMessageTask } from '../src/interfaces/guided/task-message.js';
import { readTaskInput } from '../src/interfaces/guided/task-input.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { watchKeys } from '../src/interfaces/guided/watch.js';
import { taskFrame } from '../src/interfaces/guided/task-screen.js';
import { TaskFeed } from '../src/interfaces/guided/task-feed.js';
import { terminalText } from '../src/interfaces/guided/screen.js';
import { dispatch } from '../src/interfaces/routes.js';
import type { CliContext, StatusView, TaskView } from '../src/interfaces/types.js';
import { inputApplication } from './task-input-fixture.js';
import { ScriptedProvider, cleanup, eventually, output } from './helpers.js';

vi.mock('../src/interfaces/guided/task-input.js', () => ({ readTaskInput: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

/** Оставляет реальный запуск внутри модельного запроса до явного завершения тестом. */
async function activeTask() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider = new ScriptedProvider(async () => {
    await gate;
    return output('Ответ');
  });
  const app = await inputApplication(provider);
  cleanup(async () => {
    finish();
  });
  const run = await app.runtime.start({
    message: 'Исходная задача',
    workspace: app.workspace,
    requestKey: 'initial',
  });
  await eventually(() => provider.requests.length > 0);
  const status = (await dispatch(app, 'runtime.status', { runId: run.runId })) as StatusView;
  const scope = {
    workspace: status.workspace,
    profile: status.profile,
    sessionId: status.sessionId,
    messageRunId: status.runId,
  };
  return { app, run, status, scope, finish };
}

/** Подменяет только транспорт клиента; проверки и запись черновиков остаются настоящими. */
function client(request: (method: string, params: unknown) => Promise<unknown>): CliContext {
  return {
    request: request as CliContext['request'],
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  };
}

it('уточнение сохраняется до отправки, не меняет многострочный текст и не создаёт запуск', async () => {
  const { app, status, scope, finish } = await activeTask();
  const text = '  Уточнение\n\nНе меняй файл 日本語.txt.\n';
  vi.mocked(readTaskInput).mockImplementation(async (options) => {
    expect(options.message).toBe('Написать модели');
    expect(options.workspace).toBe(app.workspace);
    await options.save(text);
    return text;
  });
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method === 'runtime.message') {
      const draft = (await app.drafts.list(scope)).items[0]!;
      expect(draft.state).toBe('pending');
      expect(draft.requestKey).toBe((params as { requestKey: string }).requestKey);
    }
    return dispatch(app, method, params);
  });
  const notice = await writeTaskMessage(client(request), status);
  expect(notice).toContain('принято и сохранено');
  expect(app.sessions.get(status.runId).userMessages?.[0]?.content).toBe(text);
  expect((await app.drafts.list(scope)).total).toBe(0);
  expect(app.sessions.list()).toHaveLength(1);
  expect(
    request.mock.calls.some(([method]) => ['runtime.run', 'runtime.cancel'].includes(method)),
  ).toBe(false);
  const queued = (await dispatch(app, 'runtime.task', { runId: status.runId })) as TaskView;
  const queuedEvent = queued.events.find((event) => event.type === 'user.message_queued');
  expect(queuedEvent?.title).toBe('Сообщение сохранено в очереди');
  expect(queuedEvent?.role).toBe('Вы');
  expect(queuedEvent?.detail).toBe(text);
  finish();
  await app.runtime.wait(status.runId);
  const completed = (await dispatch(app, 'runtime.task', { runId: status.runId })) as TaskView;
  const feed = new TaskFeed();
  feed.update(completed);
  expect(feed.items('log').map((item) => item.text)).toContain(
    'Сообщение добавлено в контекст модели',
  );
});

it('потерянный ACK сохраняет ключ; просмотр не отправляет повтор, повтор после завершения не дублируется', async () => {
  const { app, status, scope, finish } = await activeTask();
  const text = 'Моё уточнение\nс двумя строками';
  vi.mocked(readTaskInput).mockImplementation(async (options) => {
    await options.save(text);
    return text;
  });
  let lost = true;
  const keys: string[] = [];
  const request = async (method: string, params: unknown) => {
    const result = await dispatch(app, method, params);
    if (method === 'runtime.message') {
      keys.push((params as { requestKey: string }).requestKey);
      if (lost) {
        lost = false;
        throw new Error('Local service closed the connection before completion');
      }
    }
    return result;
  };
  vi.mocked(liveSelect).mockResolvedValueOnce('read').mockResolvedValueOnce('back');
  vi.mocked(readText).mockImplementation(async (_title, tabs) => {
    expect(tabs[0]?.text).toBe(text);
    return 'back';
  });
  expect(await writeTaskMessage(client(request), status)).toContain('Отправка не подтверждена');
  expect(keys).toHaveLength(1);
  const saved = (await app.drafts.list(scope)).items[0]!;
  expect(saved.state).toBe('pending');
  finish();
  await app.runtime.wait(status.runId);
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    if (options.title === 'Сохранённые черновики') return saved.id;
    expect(menu.options[0]?.label).toBe('Проверить отправку');
    return 'restore';
  });
  expect(await writeTaskMessage(client(request), status)).toContain('добавлено в контекст');
  expect(keys).toEqual([saved.requestKey, saved.requestKey]);
  expect(app.sessions.get(status.runId).userMessages).toHaveLength(1);
  expect(app.sessions.list()).toHaveLength(1);
  expect(readTaskInput).toHaveBeenCalledTimes(1);
  expect((await app.drafts.list(scope)).total).toBe(0);
});

it('завершение во время ввода сохраняет полный черновик без отправки и нового запуска', async () => {
  const { app, status, scope, finish } = await activeTask();
  const text = 'Осталось уточнение\n' + '日本語'.repeat(500);
  vi.mocked(readTaskInput).mockImplementation(async (options) => {
    await options.save(text);
    finish();
    await app.runtime.wait(status.runId);
    await options.refresh!();
    expect(options.description!()).toContain('Задача завершена');
    return text;
  });
  vi.mocked(readText).mockImplementation(async (_title, tabs) => {
    expect(tabs[0]?.text).toBe(text);
    return 'back';
  });
  const request = vi.fn((method: string, params: unknown) => dispatch(app, method, params));
  expect(await writeTaskMessage(client(request), status)).toContain('осталось в черновиках');
  const saved = (await app.drafts.list(scope)).items[0]!;
  expect((await app.drafts.get({ id: saved.id, sessionId: status.sessionId })).text).toBe(text);
  expect(saved.state).toBe('editing');
  expect(
    request.mock.calls.some(([method]) => ['runtime.run', 'runtime.message'].includes(method)),
  ).toBe(false);
});

it('Esc сохраняет уточнение отдельно от нового этапа беседы', async () => {
  const { app, status, scope } = await activeTask();
  vi.mocked(readTaskInput).mockImplementation(async (options) => {
    await options.save('Не потерять\nчерновик');
    return Symbol('saved');
  });
  expect(
    await writeTaskMessage(
      client((method, params) => dispatch(app, method, params)),
      status,
    ),
  ).toContain('Черновик');
  expect((await app.drafts.list(scope)).total).toBe(1);
  expect(
    (
      await app.drafts.list({
        workspace: status.workspace,
        profile: status.profile,
        sessionId: status.sessionId,
        expectedParentRunId: status.runId,
      })
    ).total,
  ).toBe(0);
  expect(app.sessions.get(status.runId).userMessages).toBeUndefined();
});

it.each(['running', 'awaiting_approval', 'paused'] as const)(
  'экран 48×24 сохраняет управление и живую очередь в состоянии %s',
  (status) => {
    const feed = new TaskFeed();
    const view: TaskView = {
      runId: 'run',
      task: 'Рабочая задача',
      sessionId: 'session',
      workspace: '/workspace',
      profile: 'test',
      status,
      turns: 2,
      learningVersion: 'baseline',
      usage: { input: 0, output: 0 },
      cursor: 0,
      agents: [],
      approvals: [],
      unknownInvocations: [],
      pendingMessages: 2,
      events: [],
      output: { events: [], cursor: 0, hasMore: false },
    };
    feed.update(view);
    const frame = terminalText(
      taskFrame(feed, 48, 24, 'all', 0, undefined, false, 'Сообщение принято и сохранено.'),
    );
    expect(frame).toContain('Ctrl+W — написать модели');
    expect(frame).toContain('Сообщений в очереди: 2');
    expect(frame.split('\n').length).toBeLessThan(24);
    expect(frame.split('\n').every((line) => line.length < 48)).toBe(true);
    feed.update({ ...view, pendingMessages: 0 });
    expect(taskFrame(feed, 48, 24, 'all', 0)).not.toContain('Сообщений в очереди:');
    expect(canMessageTask(view)).toBe(true);
    expect(canMessageTask({ ...view, deletedAt: 'now' })).toBe(false);
  },
);

it('горячая клавиша уточнения отделена от отмены, обработчики освобождаются', () => {
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const raw = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdin, 'setRawMode', { value: vi.fn(), configurable: true });
  const action = vi.fn();
  const stop = watchKeys(action);
  try {
    process.stdin.emit('keypress', '\u0017', { ctrl: true, name: 'w' });
    expect(action).toHaveBeenCalledWith('message');
    expect(action).not.toHaveBeenCalledWith('cancel');
    stop();
    process.stdin.emit('keypress', '\u0017', { ctrl: true, name: 'w' });
    expect(action).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (raw) Object.defineProperty(process.stdin, 'setRawMode', raw);
    else Reflect.deleteProperty(process.stdin, 'setRawMode');
  }
});
