import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { newTask, chooseTask } from '../src/interfaces/guided/tasks.js';
import { taskDetails } from '../src/interfaces/guided/task-details.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { followRun } from '../src/interfaces/guided/watch.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import type { TaskDraft } from '../src/sessions/drafts.js';
import { randomUUID } from 'node:crypto';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/watch.js', () => ({ followRun: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.resetAllMocks());

function client(request: (method: string, params?: unknown) => Promise<unknown>): CliContext {
  const drafts = new Map<string, TaskDraft>();
  const connected = async (method: string, params?: unknown): Promise<unknown> => {
    if (!method.startsWith('drafts.')) return request(method, params);
    const value = params as Partial<TaskDraft> & { expectedRevision?: number };
    if (method === 'drafts.list') return { items: [], total: 0 };
    if (method === 'drafts.create') {
      const draft = {
        schemaVersion: 1,
        id: randomUUID(),
        revision: 0,
        state: 'editing',
        updatedAt: new Date().toISOString(),
        ...value,
        requestKey: value.requestKey ?? randomUUID(),
      } as TaskDraft;
      drafts.set(draft.id, draft);
      return draft;
    }
    const draft = drafts.get(value.id!)!;
    if (method === 'drafts.get') return draft;
    if (method === 'drafts.remove') return { removed: drafts.delete(value.id!) };
    const changed = { ...draft, ...value, revision: draft.revision + 1 };
    drafts.set(draft.id, changed);
    return changed;
  };
  return {
    request: connected as CliContext['request'],
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  };
}

function task(status: StatusView['status'] = 'cancelled'): StatusView {
  return {
    runId: 'run',
    sessionId: 'session',
    task: 'Изучи проект',
    workspace: '/workspace',
    profile: 'test',
    status,
    turns: 3,
    usage: { input: 25, output: 10 },
    learningVersion: 'baseline',
    agents: [],
    approvals: [],
    unknownInvocations: [],
    cursor: 0,
    events: [],
  };
}

it('ответ на уточнение модели сохраняет вопрос, исходную задачу и результаты чтения', async () => {
  const root = await temporary();
  const question = 'Какие ключи проверяем: настройки Studio или API-ключи?';
  const reply = 'Настройки, тексты и SEO в Studio';
  const provider = new ScriptedProvider((_, index) => {
    if (index === 0) return output('', [call('read', 'fs.read', { path: 'notes.txt' })]);
    return output(index === 1 ? question : 'Уточнение принято: проверяем Studio');
  });
  const app = await createApplication(
    await configDirectory(root, 'http://127.0.0.1:1/v1'),
    join(root, 'state'),
    provider,
  );
  cleanup(() => app.close());
  const workspace = join(root, 'workspace');
  await writeFile(join(workspace, 'notes.txt'), 'Проверяемый факт из Studio');
  const first = await app.runtime.start({
    message: 'Проверь ключи в админке',
    workspace,
    requestKey: 'question',
  });
  await app.runtime.wait(first.runId);
  const saved = (await dispatch(app, 'runtime.status', { runId: first.runId })) as StatusView;
  expect(saved.status).toBe('completed');
  expect(saved.result).toBe(question);
  const original = structuredClone(app.sessions.get(first.runId));
  vi.mocked(prompts.text).mockResolvedValue(reply);
  vi.mocked(followRun).mockImplementation(async (_, runId) => {
    await app.runtime.wait(runId);
    return (await dispatch(app, 'runtime.status', { runId })) as StatusView;
  });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('Ответ получен');
    expect(menu.options.find((item) => item.value === 'continue')?.label).toBe(
      'Ответить или продолжить',
    );
    expect(menu.options.find((item) => item.value === 'answer')?.label).toBe('Прочитать ответ');
    return 'back';
  });
  await newTask(
    client((method, params) => dispatch(app, method, params)),
    { workspace: '/another-project', profile: 'another-profile' },
    saved,
  );
  expect(prompts.text).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Ваш ответ модели или следующий шаг',
    }),
  );
  const next = app.sessions.list().find((run) => run.id !== first.runId)!;
  expect(next.sessionId).toBe(saved.sessionId);
  expect(next.workspace).toBe(workspace);
  expect(next.profile).toBe(saved.profile);
  expect(next.status).toBe('completed');
  const messages = provider.requests[2]!.messages;
  const history = JSON.stringify(messages);
  expect(history).toContain('Проверь ключи в админке');
  expect(history).toContain('Проверяемый факт из Studio');
  expect(history).toContain(question);
  expect(history).toContain(reply);
  expect(history.indexOf(question)).toBeLessThan(history.lastIndexOf(reply));
  expect(app.sessions.get(first.runId)).toEqual(original);
  expect(Object.values(next.invocations)).toHaveLength(0);
});

it.each(['cancelled', 'failed'] as const)(
  '%s: продолжение создаёт новый этап с прочитанным файлом в истории, не повторяя старые вызовы',
  async (status) => {
    const root = await temporary();
    const provider = new ScriptedProvider((_, index) => {
      if (index === 0) return output('', [call('read', 'fs.read', { path: 'notes.txt' })]);
      if (index === 1) {
        if (status === 'failed') throw new Error('Проверочная ошибка модели');
        return output('', [call('exec', 'process.exec', { command: 'echo', args: ['test'] })]);
      }
      return output('Продолжено с сохранённой историей');
    });
    const app = await createApplication(
      await configDirectory(root, 'http://127.0.0.1:1/v1'),
      join(root, 'state'),
      provider,
    );
    cleanup(() => app.close());
    const workspace = join(root, 'workspace');
    await writeFile(join(workspace, 'notes.txt'), 'Проверяемый факт из файла');
    const previous = await app.runtime.start({
      message: 'Изучи проект и проверь окружение',
      workspace,
      requestKey: 'first',
    });
    if (status === 'cancelled') {
      await eventually(() => app.approvals.pending().length === 1);
      await app.runtime.cancel(previous.runId);
    }
    await app.runtime.wait(previous.runId);
    const saved = (await dispatch(app, 'runtime.status', { runId: previous.runId })) as StatusView;
    expect(saved.status).toBe(status);
    await expect(app.runtime.resume(previous.runId)).rejects.toThrow('Only paused');
    vi.mocked(prompts.text).mockImplementation(async (options) => options.initialValue!);
    const request = vi.fn((method: string, params?: unknown) => dispatch(app, method, params));
    await newTask(client(request), { workspace: '/other-folder', profile: 'other' }, saved);
    const next = app.sessions.list().at(-1)!;
    await app.runtime.wait(next.id);
    expect(next.id).not.toBe(previous.runId);
    expect(next.sessionId).toBe(previous.sessionId);
    expect(next.workspace).toBe(workspace);
    expect(next.profile).toBe('test');
    expect(app.sessions.get(next.id).status).toBe('completed');
    expect(provider.requests.at(-1)?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Изучи проект и проверь окружение' }),
        expect.objectContaining({
          role: 'tool',
          content: expect.stringContaining('Проверяемый факт из файла'),
        }),
      ]),
    );
    expect(Object.keys(app.sessions.get(next.id).invocations)).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === 'runtime.run')).toHaveLength(1);
    expect(prompts.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'С чего продолжить?',
        initialValue: 'Продолжи исходную задачу. Учти результаты и проверь прерванные действия.',
      }),
    );
  },
);

it('Esc из просмотра возвращает список задач, сохраняя поиск', async () => {
  const history = { active: [], items: [task()], page: 0, pages: 1, total: 1 };
  const request = vi.fn(async () => history);
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      await options.load();
      return 'search';
    })
    .mockImplementationOnce(async (options) => {
      await options.load();
      return 'run';
    })
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).summary).toContain('Поиск: Изучи');
      return 'back';
    });
  vi.mocked(prompts.text).mockResolvedValueOnce('Изучи');
  vi.mocked(followRun).mockResolvedValueOnce(undefined);
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(liveSelect).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith('runtime.history', {
    page: 0,
    query: 'Изучи',
    includeDeleted: false,
  });
});

it('Esc в тексте продолжения возвращает действия и ничего не запускает', async () => {
  const current = task();
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [], items: [current], page: 0, pages: 1, total: 1 }
      : current,
  );
  vi.mocked(followRun).mockResolvedValueOnce(current);
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options).toContainEqual({
        value: 'continue',
        label: 'Продолжить задачу',
        hint: 'с сохранённой перепиской',
      });
      return 'continue';
    })
    .mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce(Symbol('cancel'));
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(liveSelect).toHaveBeenCalledTimes(3);
  expect(request.mock.calls.some(([method]) => method === 'runtime.run')).toBe(false);
});

it('Esc из продолженного этапа возвращает каталог; длинная исходная задача не заполняет поле', async () => {
  const current = { ...task(), task: 'Длинная исходная задача '.repeat(100) };
  const request = vi.fn(async (method: string) => {
    if (method === 'runtime.history')
      return { active: [], items: [current], page: 0, pages: 1, total: 1 };
    if (method === 'runtime.run') return { runId: 'next-run' };
    return current;
  });
  vi.mocked(followRun).mockResolvedValueOnce(current).mockResolvedValueOnce(undefined);
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockResolvedValueOnce('continue')
    .mockImplementationOnce(async (options) => {
      expect(options.title).toBe('Мои задачи');
      return 'back';
    });
  vi.mocked(prompts.text).mockImplementationOnce(async (options) => {
    expect(options.initialValue!.length).toBeLessThan(100);
    expect(options.initialValue).not.toContain(current.task);
    return options.initialValue!;
  });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(liveSelect).toHaveBeenCalledTimes(3);
  expect(followRun).toHaveBeenLastCalledWith(expect.anything(), 'next-run');
  expect(request).toHaveBeenCalledWith(
    'runtime.run',
    expect.objectContaining({ sessionId: current.sessionId }),
  );
});

it('пустой список позволяет начать первую задачу без возврата в главное меню', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [], items: [], page: 0, pages: 1, total: 0 }
      : { runId: 'new-run' },
  );
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options[0]).toEqual({ value: 'new', label: 'Новая задача' });
      return 'new';
    })
    .mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce('Изучи README');
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(request).toHaveBeenCalledWith(
    'runtime.run',
    expect.objectContaining({ message: 'Изучи README', workspace: '/workspace' }),
  );
});

it('пауза продолжает тот же запуск и не подменяет его новым разговором', async () => {
  const current = task('paused');
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [current], items: [], page: 0, pages: 1, total: 0 }
      : current,
  );
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.options).toContainEqual({ value: 'resume', label: 'Продолжить после паузы' });
      expect(menu.options.some((item) => item.value === 'continue')).toBe(false);
      return 'resume';
    });
  vi.mocked(followRun).mockResolvedValueOnce(current).mockResolvedValueOnce(undefined);
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(request).toHaveBeenCalledWith('runtime.resume', { runId: 'run' });
  expect(request.mock.calls.some(([method]) => method === 'runtime.run')).toBe(false);
});

it('Esc при создании первой задачи возвращает пустой список', async () => {
  const request = vi.fn(async (_method: string) => ({
    active: [],
    items: [],
    page: 0,
    pages: 1,
    total: 0,
  }));
  vi.mocked(liveSelect).mockResolvedValueOnce('new').mockResolvedValueOnce('back');
  vi.mocked(prompts.text).mockResolvedValueOnce(Symbol('cancel'));
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(liveSelect).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.some(([method]) => method === 'runtime.run')).toBe(false);
});

it('продолжение в другом окне отменяет устаревший выбор resume без повторного запроса', async () => {
  const current = task('paused');
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [current], items: [], page: 0, pages: 1, total: 0 }
      : structuredClone(current),
  );
  vi.mocked(followRun).mockResolvedValueOnce(structuredClone(current));
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options.some((item) => item.value === 'resume')).toBe(true);
      current.status = 'running';
      return 'resume';
    })
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.summary).toContain('Состояние изменилось в другом окне');
      expect(menu.options.some((item) => item.value === 'resume')).toBe(false);
      return 'back';
    });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(
    request.mock.calls.some(([method]) => ['runtime.resume', 'runtime.run'].includes(method)),
  ).toBe(false);
  expect(followRun).toHaveBeenCalledOnce();
});

it('проверка позже оставляет задачу на паузе и возвращает действия без запуска', async () => {
  const current = task('paused');
  current.unknownInvocations = [
    { id: 'write', tool: 'fs.write', arguments: '{"path":"result.txt"}' },
  ];
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [current], items: [], page: 0, pages: 1, total: 0 }
      : structuredClone(current),
  );
  vi.mocked(followRun).mockResolvedValueOnce(current);
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockResolvedValueOnce('resume')
    .mockImplementationOnce(async (options) => {
      expect(options.title).toBe('Проверка прерванной операции');
      expect((await options.load()).options).toContainEqual({
        value: 'later',
        label: 'Проверить позже',
      });
      return 'later';
    })
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).options).toContainEqual({
        value: 'resume',
        label: 'Продолжить после паузы',
      });
      return 'back';
    });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(
    request.mock.calls.some(([method]) =>
      ['runtime.resolve', 'runtime.resume', 'runtime.run'].includes(method),
    ),
  ).toBe(false);
  expect(current.status).toBe('paused');
  expect(followRun).toHaveBeenCalledOnce();
});

it('продолжение не запускается, если задача уже работает в другом окне', async () => {
  const request = vi.fn(async () => task('running'));
  vi.mocked(prompts.text).mockResolvedValueOnce('Продолжи');
  await expect(
    newTask(client(request), { workspace: '/workspace', profile: 'test' }, task()),
  ).rejects.toThrow('Состояние задачи изменилось');
  expect(request).toHaveBeenCalledExactlyOnceWith('runtime.status', { runId: 'run' });
});

it('описание исходного опыта понятно без знания внутреннего имени версии', () => {
  const execution = taskDetails(task()).find((tab) => tab.id === 'execution')!.text;
  expect(execution).toContain('начальные инструкции, без накопленных знаний');
  expect(execution).not.toContain('baseline');
});

it('достигнутый предел объясняет новую порцию и оставляет продолжение доступным', async () => {
  const current: StatusView = {
    ...task('paused'),
    error: 'Достигнут предел 5 шагов. Задача сохранена на паузе; можно продолжить.',
    iterations: { limit: 5, used: 5, total: 10, remaining: 0, pausedByLimit: true, editable: true },
  };
  const request = vi.fn(async (method: string) =>
    method === 'runtime.history'
      ? { active: [current], items: [], page: 0, pages: 1, total: 0 }
      : structuredClone(current),
  );
  vi.mocked(followRun).mockResolvedValueOnce(current);
  vi.mocked(liveSelect)
    .mockResolvedValueOnce('run')
    .mockImplementationOnce(async (options) => {
      const menu = await options.load();
      expect(menu.summary).toContain(
        'Предел шагов достигнут. «Продолжить после паузы» даст ещё 5 шагов.',
      );
      expect(menu.options).toContainEqual({ value: 'resume', label: 'Продолжить после паузы' });
      expect(menu.options).toContainEqual({ value: 'iterations', label: 'Предел шагов задачи' });
      return 'back';
    });
  await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
  expect(current.error).toContain('Достигнут предел 5 шагов.');
  expect(request.mock.calls.map(([method]) => method)).not.toContain('runtime.resume');
});

it.each([
  [
    'paused',
    'Достигнута квота этой задачи. Она сохранена на паузе; можно добавить токены и продолжить.',
    true,
  ],
  [
    'paused',
    'Достигнута общая дневная квота API. Новых запросов нет. Увеличьте квоту в настройках или продолжите после смены суток UTC.',
    true,
  ],
  ['paused', 'HTTP 429: provider quota exceeded', false],
  [
    'failed',
    'Достигнута квота этой задачи. Она сохранена на паузе; можно добавить токены и продолжить.',
    false,
  ],
] as const)(
  '%s: подсказка прежней локальной квоты не переписывает сохранённую ошибку',
  async (state, error, previousQuota) => {
    const current = { ...task(state), error };
    const request = vi.fn(async (method: string) =>
      method === 'runtime.history'
        ? { active: [current], items: [], page: 0, pages: 1, total: 0 }
        : structuredClone(current),
    );
    vi.mocked(followRun).mockResolvedValueOnce(current);
    vi.mocked(liveSelect)
      .mockResolvedValueOnce('run')
      .mockImplementationOnce(async (options) => {
        const menu = await options.load();
        if (previousQuota) {
          expect(menu.summary).toContain(
            'Прежняя квота отключена. Выберите «Продолжить после паузы».',
          );
          expect(menu.summary).not.toContain('Достигнута');
          expect(menu.options).toContainEqual({ value: 'resume', label: 'Продолжить после паузы' });
        } else expect(menu.summary).not.toContain('Прежняя квота отключена');
        return 'back';
      });
    await chooseTask(client(request), { workspace: '/workspace', profile: 'test' });
    expect(current.error).toBe(error);
    expect(taskDetails(current).find((tab) => tab.id === 'errors')!.text).toContain(error);
    expect(
      request.mock.calls.every(([method]) =>
        ['runtime.history', 'runtime.status', 'system.info'].includes(method),
      ),
    ).toBe(true);
  },
);
