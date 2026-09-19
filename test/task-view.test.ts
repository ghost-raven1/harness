import { repairJournalTail } from '../src/sessions/journal.js';
import { expect, it } from 'vitest';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { RunOutputStore, type OutputEvent } from '../src/sessions/output.js';
import { TaskFeed } from '../src/interfaces/guided/task-feed.js';
import { taskFrame } from '../src/interfaces/guided/task-screen.js';
import { terminalText } from '../src/interfaces/guided/screen.js';
import type { TaskView } from '../src/interfaces/types.js';
import {
  ScriptedProvider,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  temporary,
} from './helpers.js';
import { command, modelServer, startDaemon } from './process-fixture.js';

const event = (seq: number, type: OutputEvent['type'], text?: string): OutputEvent => ({
  seq,
  type,
  text,
  at: '2026-09-12T01:00:00.000Z',
  requestId: 'request',
  agentId: 'agent',
  role: 'coordinator',
});
function view(events: OutputEvent[]): TaskView {
  return {
    runId: 'task',
    task: 'Проверка экрана',
    sessionId: 'session',
    workspace: '/workspace',
    profile: 'fixture',
    status: 'running',
    turns: 1,
    learningVersion: 'baseline',
    usage: { input: 0, output: 0 },
    cursor: 0,
    events: [],
    agents: [],
    approvals: [],
    unknownInvocations: [],
    output: { events, cursor: events.at(-1)?.seq ?? 0, hasMore: false },
  };
}

it('показывает частичный ответ до завершения модели и восстанавливает его после перезапуска', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider = new ScriptedProvider(async (request) => {
    request.onProgress?.({ type: 'reasoning', text: 'Проверяю исходные данные.' });
    request.onProgress?.({ type: 'text', text: 'Первый фрагмент. ' });
    await pending;
    request.onProgress?.({ type: 'text', text: 'Готово.' });
    return { ...output('Первый фрагмент. Готово.'), reasoning: 'Проверяю исходные данные.' };
  });
  const app = await createApplication(config, state, provider);
  cleanup(() => app.close());
  cleanup(async () => {
    finish();
  });
  const run = await app.runtime.start({
    message: 'Поток',
    workspace: join(root, 'workspace'),
    requestKey: 'stream',
  });
  await eventually(async () =>
    (await app.sessions.output.page(run.runId, 0)).events.some((row) => row.type === 'text'),
  );
  const partial = (await dispatch(app, 'runtime.task', { runId: run.runId })) as TaskView;
  expect(partial.status).toBe('running');
  expect(partial.result).toBeUndefined();
  expect(partial.output.events.map((row) => row.text).join('')).toContain('Первый фрагмент.');
  expect(partial.events.map((row) => row.type)).toContain('model.requested');
  expect(JSON.stringify(partial)).not.toContain('basePrompt');
  finish();
  await app.runtime.wait(run.runId);
  const completed = (await dispatch(app, 'runtime.task', { runId: run.runId })) as TaskView;
  const feed = new TaskFeed();
  feed.update(partial);
  feed.update(completed);
  expect(feed.items('text').map((item) => item.text)).toEqual(['Первый фрагмент. Готово.']);
  expect(feed.items('reasoning').map((item) => item.text)).toEqual(['Проверяю исходные данные.']);
  expect(
    new Set(
      completed.events.filter((row) => row.type === 'model.completed').map((row) => row.preview),
    ),
  ).toEqual(new Set([undefined]));
  await app.close();
  const recovered = new FileSessionStore(state);
  await recovered.initialize();
  expect(await recovered.output.page(run.runId, 0)).toEqual(completed.output);
  expect(recovered.get(run.runId).result).toBe('Первый фрагмент. Готово.');
});

it('пачки ограничены, страницы не теряются, оборванный хвост журнала восстанавливается', async () => {
  const root = await temporary(),
    store = new RunOutputStore(root);
  const writer = await store.begin('run', 'agent', 'worker');
  writer.progress({ type: 'text', text: 'я'.repeat(80000) });
  writer.progress({ type: 'reasoning', text: '思'.repeat(80000) });
  await writer.finish();
  const first = await store.page('run', 0),
    second = await store.page('run', first.cursor);
  expect(first.hasMore).toBe(true);
  expect(second.hasMore).toBe(false);
  const events = [...first.events, ...second.events];
  expect(events.every((row) => (row.text?.length ?? 0) <= 4096)).toBe(true);
  expect(
    events
      .filter((row) => row.type === 'text')
      .map((row) => row.text)
      .join(''),
  ).toHaveLength(65536);
  expect(events.filter((row) => row.type === 'truncated')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('failed');
  await appendFile(join(root, 'output', 'run.jsonl'), '{"seq":');
  await expect(new RunOutputStore(root).page('run', 0)).rejects.toThrow('JOURNAL_TORN_TAIL');
  // Ремонт выполняет владелец до открытия страниц.
  await repairJournalTail(join(root, 'output', 'run.jsonl'));
  expect(await new RunOutputStore(root).page('run', 0)).toEqual(first);
});

it('повторные попытки и параллельные роли не смешивают ответы', () => {
  const feed = new TaskFeed();
  const status = view([
    event(1, 'text', 'Оборванный'),
    event(2, 'retry', 'Попытка 2'),
    event(3, 'text', 'Полный'),
    { ...event(4, 'text', 'Другой агент'), requestId: 'child', role: 'worker' },
  ]);
  feed.update(status);
  feed.update(status);
  expect(feed.items('text').map((item) => item.text)).toEqual([
    'Оборванный',
    'Полный',
    'Другой агент',
  ]);
  expect(feed.items('log').map((item) => item.text)).toEqual(['Попытка 2']);
});

it('старый журнал показывает ответ и пояснения без подписей и управляющих последовательностей', () => {
  const feed = new TaskFeed();
  feed.update({
    ...view([]),
    events: [
      {
        seq: 1,
        type: 'model.completed',
        payload: {},
        preview: { text: '\x1b[2JОтвет', reasoning: 'Пояснение' },
      },
    ],
  });
  expect(feed.items('text')[0]?.text).toBe('Ответ');
  expect(terminalText('\x1b]52;c;secret\x07safe\x1b[31m\x00')).toBe('safe');
  expect(feed.items('reasoning')[0]?.text).toBe('Пояснение');
});

it.each([48, 90])(
  'экран %i колонок сохраняет навигацию и позволяет читать начало длинного ответа',
  (width) => {
    const feed = new TaskFeed();
    feed.update(
      view([event(1, 'text', Array.from({ length: 100 }, (_, i) => 'Строка ' + i).join('\n'))]),
    );
    const tail = terminalText(taskFrame(feed, width, 24, 'text', 0));
    expect(tail).toContain('Строка 99');
    expect(tail).not.toMatch(/│\s+Строка 0\s+│/);
    expect(tail).toContain('Esc — назад');
    expect(tail).toContain('Enter — действия');
    expect(tail.split('\n').length).toBeLessThanOrEqual(23);
    expect(tail.split('\n').every((line) => line.length < width)).toBe(true);
    expect(terminalText(taskFrame(feed, width, 24, 'text', 10000))).toMatch(/│\s+Строка 0\s+│/);
    expect(terminalText(taskFrame(feed, width, 24, 'reasoning', 0))).toContain(
      'Модель пока не передала пояснения.',
    );
  },
);

it('удаление сохраняет файлы, доказательства, квоту и ключ повторного запроса', async () => {
  const provider = new ScriptedProvider(() => output('Готово'));
  const app = await harness(provider);
  const input = { message: 'Удаляемая задача', workspace: app.workspace, requestKey: 'delete' };
  const run = await app.runtime.start(input);
  await app.runtime.wait(run.runId);
  const artifact = await app.sessions.artifact(run.runId, 'Доказательство');
  const budget = await app.runtime.usage.status(run.runId);
  await app.sessions.delete(run.runId);
  await app.sessions.delete(run.runId);
  expect(
    (await app.sessions.history(run.runId, 0)).filter((row) => row.type === 'run.deleted'),
  ).toHaveLength(1);
  expect(app.sessions.list()).toHaveLength(0);
  expect(app.sessions.list(true)).toHaveLength(1);
  expect(await app.runtime.start(input)).toEqual(run);
  expect(provider.requests).toHaveLength(1);
  expect(await app.runtime.usage.status(run.runId)).toEqual(budget);
  const restarted = new FileSessionStore(app.sessions.directory);
  await restarted.initialize();
  expect(restarted.list()).toEqual([]);
  expect(await restarted.readArtifact(run.runId, artifact, 0, 100)).toBe('Доказательство');
  expect((await restarted.history(run.runId, 0)).at(-1)?.type).toBe('run.deleted');
});

it('активная задача удаляется только после завершённой отмены', async () => {
  const provider = new ScriptedProvider(async (request) => {
    request.onProgress?.({ type: 'text', text: 'Частичный ответ' });
    await new Promise<void>((resolve) =>
      request.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new Error('Отмена');
  });
  const app = await harness(provider);
  const run = await app.runtime.start({
    message: 'Медленная',
    workspace: app.workspace,
    requestKey: 'cancel-delete',
  });
  await eventually(() => provider.requests.length > 0);
  await expect(app.sessions.delete(run.runId)).rejects.toThrow('Сначала остановите');
  await app.runtime.cancel(run.runId);
  await app.sessions.delete(run.runId);
  expect(app.sessions.get(run.runId).status).toBe('cancelled');
  const stream = await app.sessions.output.page(run.runId, 0);
  expect(stream.events.map((row) => row.text).join('')).toContain('Частичный ответ');
  expect(stream.events.at(-1)?.type).toBe('failed');
});

it('CLI delete требует подтверждения, JSON остаётся машинным и удаление переживает чтение истории', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Ответ для удаления' }));
  await startDaemon(await configDirectory(root, api.baseUrl), state);
  const args = ['--state', state, '--json'];
  const started = await command([...args, 'run', 'Задача', '--workspace', join(root, 'workspace')]);
  expect(started.code).toBe(0);
  const run = JSON.parse(started.stdout.trim().split('\n').at(-1)!) as TaskView;
  expect((await command([...args, 'delete', run.runId])).code).toBe(1);
  const deleted = await command([...args, 'delete', run.runId, '--yes']);
  expect(deleted.code).toBe(0);
  expect(JSON.parse(deleted.stdout)).toEqual({ deleted: true, runId: run.runId });
  expect(deleted.stdout).not.toContain('\x1b');
  expect(JSON.parse((await command([...args, 'status'])).stdout)).toEqual([]);
  expect(
    JSON.parse(await readFile(join(state, 'runs', run.runId + '.json'), 'utf8')).deletedAt,
  ).toBeDefined();
});
