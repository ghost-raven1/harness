import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Application } from '../src/interfaces/application.js';
import { fileCommand } from '../src/interfaces/file-routes.js';
import { FileChanges } from '../src/tools/file-changes.js';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { ProviderError } from '../src/providers/errors.js';
import { call, eventually, harness, output, ScriptedProvider } from './helpers.js';

/** Позволяет остановить проверяемую операцию на конкретной границе, не угадывая задержку диска. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Создаёт завершённую запись с резервной копией в изолированной папке. */
async function written() {
  const provider = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [call('write', 'fs.write', { path: 'result.txt', content: 'Новая версия' })])
      : output('Готово'),
  );
  const app = await harness(provider);
  const path = join(app.workspace, 'result.txt');
  await writeFile(path, 'Исходная версия');
  const run = await app.runtime.start({
    message: 'Обнови файл',
    workspace: app.workspace,
    requestKey: 'write',
  });
  await app.runtime.wait(run.runId);
  const files = new FileChanges(app.sessions);
  const changeId = app.sessions.get(run.runId).fileChanges![0]!.id;
  return { ...app, ...run, provider, files, changeId, path };
}

it.each([false, true])(
  'следующий вопрос учитывает откат раннего этапа (скрыт: %s)',
  async (hidden) => {
    const app = await written();
    const second = await app.runtime.start({
      message: 'Второй этап',
      workspace: app.workspace,
      sessionId: app.sessionId,
      requestKey: 'second',
    });
    await app.runtime.wait(second.runId);
    const preview = await app.files.previewRestore(app.runId, app.changeId);
    await app.files.restore(app.runId, app.changeId, preview.previewToken);
    if (hidden) await app.sessions.delete(app.runId);
    const third = await app.runtime.start({
      message: 'Третий этап',
      workspace: app.workspace,
      sessionId: app.sessionId,
      requestKey: 'third',
    });
    await app.runtime.wait(third.runId);
    expect(
      app.provider.requests
        .at(-1)!
        .messages.some((message) =>
          message.content.includes('восстановил исходное состояние файла result.txt'),
        ),
    ).toBe(true);
    expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
    const fourth = await app.runtime.start({
      message: 'Ещё один вопрос',
      workspace: app.workspace,
      sessionId: app.sessionId,
      requestKey: 'fourth',
    });
    await app.runtime.wait(fourth.runId);
    expect(
      app.provider.requests
        .at(-1)!
        .messages.filter((message) =>
          message.content.includes('восстановил исходное состояние файла result.txt'),
        ),
    ).toHaveLength(1);
  },
);

it('откат старого этапа не меняет файлы, пока продолжение беседы на паузе', async () => {
  const app = await written();
  vi.spyOn(app.provider, 'generate').mockRejectedValueOnce(
    new ProviderError('Лимит провайдера', false, false, { kind: 'rate_limit' }),
  );
  const next = await app.runtime.start({
    message: 'Продолжи',
    workspace: app.workspace,
    sessionId: app.sessionId,
    requestKey: 'paused-followup',
  });
  await app.runtime.wait(next.runId);
  expect(app.sessions.get(next.runId).status).toBe('paused');
  const preview = await app.files.previewRestore(app.runId, app.changeId);
  await expect(app.files.restore(app.runId, app.changeId, preview.previewToken)).rejects.toThrow(
    'паузе',
  );
  expect(await readFile(app.path, 'utf8')).toBe('Новая версия');
  await app.runtime.resume(next.runId);
  await app.runtime.wait(next.runId);
  expect(app.sessions.get(next.runId).status).toBe('completed');
  await app.files.restore(app.runId, app.changeId, preview.previewToken);
  expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
});

it.each([false, true])(
  'восстановление во время подготовки продолжения не пропускает старую историю (сбой: %s)',
  async (interrupted) => {
    const app = await written();
    const prepared = gate(),
      release = gate();
    const create = app.sessions.create.bind(app.sessions);
    const blocked = vi.spyOn(app.sessions, 'create').mockImplementation(async (...args) => {
      prepared.release();
      await release.promise;
      return create(...args);
    });
    const input = {
      message: 'Продолжи',
      workspace: app.workspace,
      sessionId: app.sessionId,
      requestKey: 'followup-race',
    };
    const pending = app.runtime.start(input);
    const result = pending.then(
      () => 'created',
      (error: Error) => error.message,
    );
    await prepared.promise;
    try {
      const preview = await app.files.previewRestore(app.runId, app.changeId);
      if (interrupted) {
        const mutate = app.sessions.mutate.bind(app.sessions);
        const fault = vi
          .spyOn(app.sessions, 'mutate')
          .mockImplementation((id, type, ...args) =>
            type === 'file.restored'
              ? Promise.reject(new Error('Отказ фиксации отката'))
              : mutate(id, type, ...args),
          );
        await expect(
          app.files.restore(app.runId, app.changeId, preview.previewToken),
        ).rejects.toThrow('Отказ фиксации');
        fault.mockRestore();
      } else await app.files.restore(app.runId, app.changeId, preview.previewToken);
    } finally {
      release.release();
    }
    expect(await result).toMatch(interrupted ? /неизвестным результатом/ : /беседы изменилось/);
    blocked.mockRestore();
    expect(app.sessions.list()).toHaveLength(1);
    expect(app.provider.requests).toHaveLength(2);
    if (interrupted) {
      const review = await app.files.previewResolution(app.runId, app.changeId);
      await app.files.resolveRestore(
        app.runId,
        app.changeId,
        review.previewToken,
        'Проверен исходный файл',
      );
    }
    const next = await app.runtime.start(input);
    await app.runtime.wait(next.runId);
    expect(app.sessions.get(next.runId).status).toBe('completed');
  },
);

it('задача, запущенная во время предпросмотра отката, не допускает последующей записи файла', async () => {
  const app = await written();
  const prepared = gate(),
    release = gate(),
    finishModel = gate();
  const preview = await app.files.previewRestore(app.runId, app.changeId);
  const mutate = app.sessions.mutate.bind(app.sessions);
  vi.spyOn(app.sessions, 'mutate').mockImplementation(async (id, type, ...args) => {
    if (type === 'file.restore_started') {
      prepared.release();
      await release.promise;
    }
    return mutate(id, type, ...args);
  });
  const channel = {
    sessions: app.sessions,
    runtime: app.runtime,
    scheduler: new ToolScheduler(1),
  } as Application;
  const restore = fileCommand(channel, 'files.restore', {
    runId: app.runId,
    changeId: app.changeId,
    previewToken: preview.previewToken,
  });
  const outcome = restore.then(
    () => 'restored',
    (error: Error) => error.message,
  );
  let modelStarted = false;
  vi.spyOn(app.provider, 'generate').mockImplementationOnce(async () => {
    modelStarted = true;
    await finishModel.promise;
    return output('Продолжение');
  });
  await prepared.promise;
  const next = await app.runtime.start({
    message: 'Продолжи',
    workspace: app.workspace,
    sessionId: app.sessionId,
    requestKey: 'during-restore',
  });
  try {
    await eventually(() => modelStarted);
    release.release();
    expect(await outcome).toMatch(/работающ|остановите/);
    expect(await readFile(app.path, 'utf8')).toBe('Новая версия');
    expect(app.sessions.get(app.runId).fileChanges![0]!.status).toBe('applied');
  } finally {
    release.release();
    finishModel.release();
    await app.runtime.wait(next.runId);
  }
});
