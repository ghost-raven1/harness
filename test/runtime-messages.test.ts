import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { DraftStore } from '../src/sessions/drafts.js';
import { FileSessionStore } from '../src/sessions/store.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

/** Удерживает только выбранный шаг модели или инструмента до явного разрешения теста. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('принимает уточнение во время ответа, дедуплицирует параллельные повторы и даёт модели следующий ход', async () => {
  const blocked = gate();
  const source = new ScriptedProvider(async (_, index) => {
    if (index === 0) {
      await blocked.promise;
      return output('Первый ответ');
    }
    return output('Уточнение учтено');
  });
  const app = await harness(source);
  const { runId, sessionId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Изучи проект',
    requestKey: 'start',
  });
  const request = { runId, message: 'Ответь кратко, только про сервер.', requestKey: 'clarify' };
  try {
    await eventually(() => source.requests.length === 1);
    const receipts = await Promise.all([
      app.runtime.sendMessage(request),
      app.runtime.sendMessage(request),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(receipts[0]).toMatchObject({ runId, sessionId, status: 'queued' });
    expect(app.sessions.get(runId).userMessages).toHaveLength(1);
    expect(
      app.sessions.history(runId, 0).filter((event) => event.type === 'user.message_queued'),
    ).toHaveLength(1);
    await expect(app.runtime.sendMessage({ ...request, message: 'Другой текст' })).rejects.toThrow(
      'другого сообщения',
    );
    expect(source.requests).toHaveLength(1);
  } finally {
    blocked.release();
    await app.runtime.wait(runId);
  }
  const after = app.sessions.get(runId);
  expect(after).toMatchObject({ status: 'completed', result: 'Уточнение учтено', sessionId });
  expect(source.requests).toHaveLength(2);
  expect(source.requests[1]!.messages).toContainEqual({ role: 'user', content: request.message });
  expect(
    after.agents[after.rootAgentId]!.messages.filter(
      (message) => message.content === request.message,
    ),
  ).toHaveLength(1);
  expect((await app.runtime.sendMessage(request)).status).toBe('delivered');
  await expect(app.runtime.sendMessage({ ...request, requestKey: 'late' })).rejects.toThrow(
    'уже завершена',
  );
});

it('не вставляет уточнение между вызовом записи и результатом и не повторяет запись', async () => {
  const blocked = gate();
  let writes = 0;
  const source = new ScriptedProvider((_, index) =>
    index === 0 ? output('', [call('write', 'fs.slow', {})]) : output('Готово'),
  );
  const app = await harness(source);
  app.registry.register({
    definition: {
      name: 'fs.slow',
      description: 'Долгая тестовая запись',
      schema: { type: 'object' },
      effect: 'write',
    },
    async execute() {
      writes++;
      await blocked.promise;
      return { saved: true };
    },
  });
  const { runId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Запиши результат',
    requestKey: 'write',
  });
  try {
    await eventually(() => writes === 1);
    await app.runtime.sendMessage({
      runId,
      message: 'Объясни результат записи',
      requestKey: 'during-write',
    });
    expect(source.requests).toHaveLength(1);
  } finally {
    blocked.release();
    await app.runtime.wait(runId);
  }
  expect(writes).toBe(1);
  const messages = source.requests[1]!.messages;
  const index = messages.findIndex((message) => message.toolCalls?.[0]?.id === 'write');
  expect(messages.slice(index + 1, index + 3)).toEqual([
    expect.objectContaining({ role: 'tool', toolCallId: 'write' }),
    { role: 'user', content: 'Объясни результат записи' },
  ]);
});

it('очередь во время разрешения не одобряет инструмент и не меняет политики', async () => {
  const source = new ScriptedProvider((_, index) =>
    index === 0 ? output('', [call('ask', 'fs.review', {})]) : output('Готово'),
  );
  const app = await harness(source, (config) =>
    config.policy.rules.push({ tool: 'fs.review', decision: 'ask', args: {} }),
  );
  let executed = false;
  app.registry.register({
    definition: {
      name: 'fs.review',
      description: 'Запись по разрешению',
      schema: { type: 'object' },
      effect: 'write',
    },
    async execute() {
      executed = true;
      return {};
    },
  });
  const { runId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Проверь файл',
    requestKey: 'ask',
  });
  await eventually(() => app.approvals.pending().length > 0);
  const before = app.sessions.get(runId);
  await app.runtime.sendMessage({
    runId,
    message: 'Сначала объясни, зачем нужна запись',
    requestKey: 'ask-message',
  });
  expect(app.sessions.get(runId).status).toBe('awaiting_approval');
  expect(executed).toBe(false);
  await app.approvals.resolve(app.approvals.pending()[0]!.id, false);
  await app.runtime.wait(runId);
  expect(executed).toBe(false);
  expect(app.sessions.get(runId).config).toEqual(before.config);
  expect(source.requests[1]!.messages).toContainEqual({
    role: 'user',
    content: 'Сначала объясни, зачем нужна запись',
  });
});

it('не теряет сообщение между завершением корневого агента и завершением запуска', async () => {
  const source = new ScriptedProvider((_, index) =>
    output(index === 0 ? 'Первый ответ' : 'Ответ на уточнение'),
  );
  const app = await harness(source);
  const mutate = app.sessions.mutate.bind(app.sessions);
  let injected = false;
  vi.spyOn(app.sessions, 'mutate').mockImplementation(async (runId, type, payload, update) => {
    const run = await mutate(runId, type, payload, update);
    if (type === 'agent.completed' && !injected) {
      injected = true;
      await app.runtime.sendMessage({ runId, message: 'Добавь пример', requestKey: 'finish-race' });
    }
    return run;
  });
  const { runId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Объясни',
    requestKey: 'finish',
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId)).toMatchObject({
    status: 'completed',
    result: 'Ответ на уточнение',
  });
  expect(source.requests).toHaveLength(2);
});

it('сообщение во время compaction сохраняется до отдельного шага модели', async () => {
  const blocked = gate();
  const source = new ScriptedProvider(() => output('Готово'));
  const app = await harness(source);
  let compacting = false;
  vi.spyOn(app.context, 'needsCompaction').mockReturnValueOnce(true).mockReturnValue(false);
  vi.spyOn(app.context, 'compact').mockImplementation(async (_, agent) => {
    compacting = true;
    await blocked.promise;
    return {
      messages: agent.messages,
      summary: 'Проверенная история',
      usage: { input: 1, output: 1 },
    };
  });
  const { runId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Объясни',
    requestKey: 'compact',
  });
  try {
    await eventually(() => compacting);
    await app.runtime.sendMessage({
      runId,
      message: 'Нужен русский ответ',
      requestKey: 'in-compaction',
    });
  } finally {
    blocked.release();
    await app.runtime.wait(runId);
  }
  expect(source.requests).toHaveLength(2);
  expect(source.requests[1]!.messages).toContainEqual({
    role: 'user',
    content: 'Нужен русский ответ',
  });
});

it('уточнение на паузе переживает перезапуск и применяется без нового запуска', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const source = new ScriptedProvider(() => output('Готово'));
  const original = await createApplication(configFile, join(directory, 'state'), source);
  cleanup(() => original.close());
  const { runId } = await original.runtime.start({
    workspace: join(directory, 'workspace'),
    message: 'Исходная задача',
    requestKey: 'saved',
  });
  await original.runtime.wait(runId);
  await original.sessions.mutate(runId, 'fixture.pause', {}, (run) => {
    run.status = 'paused';
  });
  const request = {
    runId,
    message: 'Продолжи с учётом новой проверки',
    requestKey: 'saved-message',
  };
  await original.runtime.sendMessage(request);
  await original.close();
  const continued = new ScriptedProvider(() => output('Продолжено'));
  const recovered = await createApplication(configFile, join(directory, 'state'), continued);
  cleanup(() => recovered.close());
  expect((await recovered.runtime.sendMessage(request)).status).toBe('queued');
  expect(recovered.sessions.get(runId).userMessages).toHaveLength(1);
  const before = recovered.sessions.get(runId);
  await recovered.runtime.resume(runId);
  await recovered.runtime.wait(runId);
  expect(continued.requests).toHaveLength(1);
  expect(continued.requests[0]!.messages).toContainEqual({
    role: 'user',
    content: request.message,
  });
  expect(recovered.sessions.get(runId)).toMatchObject({
    status: 'completed',
    config: before.config,
    learningVersion: before.learningVersion,
  });
});

it('после отмены сохраняет недоставленное сообщение в продолжении беседы', async () => {
  const blocked = gate();
  const source = new ScriptedProvider(async (_, index) => {
    if (index === 0) await blocked.promise;
    return output('Готово');
  });
  const app = await harness(source);
  const { runId, sessionId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Исходная задача',
    requestKey: 'cancel',
  });
  await eventually(() => source.requests.length === 1);
  await app.runtime.sendMessage({
    runId,
    message: 'Уточнение перед отменой',
    requestKey: 'before-cancel',
  });
  const cancellation = app.runtime.cancel(runId);
  blocked.release();
  await cancellation;
  const followup = await app.runtime.start({
    workspace: app.workspace,
    message: 'Продолжи',
    sessionId,
    requestKey: 'continue',
  });
  await app.runtime.wait(followup.runId);
  expect(source.requests[1]!.messages).toContainEqual({
    role: 'user',
    content: 'Уточнение перед отменой',
  });
});

it('черновик уточнения отделён от следующего запуска и не блокируется долгим инструментом', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const app = await createApplication(
    configFile,
    join(directory, 'state'),
    new ScriptedProvider(() => output('Готово')),
  );
  cleanup(() => app.close());
  const { runId, sessionId } = await app.runtime.start({
    workspace: join(directory, 'workspace'),
    message: 'Задача',
    requestKey: 'draft',
  });
  await app.runtime.wait(runId);
  const scope = { workspace: join(directory, 'workspace'), sessionId, messageRunId: runId };
  const blocked = gate();
  const writing = app.scheduler.schedule('write', () => blocked.promise);
  try {
    const draft = (await dispatch(app, 'drafts.create', {
      scope,
      text: 'Сохранённое уточнение',
    })) as { id: string; revision: number };
    expect(await app.drafts.list(scope)).toMatchObject({ total: 1 });
    expect(
      await app.drafts.list({ workspace: scope.workspace, sessionId, expectedParentRunId: runId }),
    ).toMatchObject({ total: 0 });
    await expect(
      app.drafts.rebase({ id: draft.id, sessionId }, draft.revision, runId),
    ).rejects.toThrow('нельзя перенести');
    const lock = await app.sessions.beginMaintenance(() => undefined);
    try {
      await expect(dispatch(app, 'drafts.create', { scope })).rejects.toThrow('Удаляется');
    } finally {
      lock();
    }
    const reopened = new FileSessionStore(join(directory, 'state'));
    await reopened.initialize();
    expect(await new DraftStore(reopened).list(scope)).toMatchObject({ total: 1 });
  } finally {
    blocked.release();
    await writing;
  }
});

it.each(['', '  ', 'x'.repeat(100001)])(
  'не принимает некорректный текст сообщения',
  async (message) => {
    const app = await harness(new ScriptedProvider(() => output('Готово')));
    await expect(async () =>
      app.runtime.sendMessage({
        runId: '00000000-0000-4000-8000-000000000001',
        message,
        requestKey: 'invalid',
      }),
    ).rejects.toThrow();
    expect(app.sessions.list()).toHaveLength(0);
  },
);
