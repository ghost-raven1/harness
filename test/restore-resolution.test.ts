import { expect, it, vi } from 'vitest';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newAgent } from '../src/agents/service.js';
import { appendJournal } from '../src/sessions/journal.js';
import { FileChanges } from '../src/tools/file-changes.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { SessionPurge } from '../src/sessions/purge.js';
import { LearningService } from '../src/learning/service.js';
import { fileCommand } from '../src/interfaces/file-routes.js';
import type { Application } from '../src/interfaces/application.js';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

/** Обрывает фиксацию уже выполненного отката, сохраняя реальный файл и неизвестный исход. */
async function interrupted(existing = true) {
  const provider = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [call('write', 'fs.write', { path: 'result.txt', content: 'Новая версия' })])
      : output('Готово'),
  );
  const app = await harness(provider);
  const path = join(app.workspace, 'result.txt');
  if (existing) await writeFile(path, 'Исходная версия');
  const run = await app.runtime.start({
    message: 'Запиши файл',
    workspace: app.workspace,
    requestKey: 'restore-fault',
  });
  await app.runtime.wait(run.runId);
  const files = new FileChanges(app.sessions);
  const changeId = app.sessions.get(run.runId).fileChanges![0]!.id;
  const preview = await files.previewRestore(run.runId, changeId);
  const mutate = app.sessions.mutate.bind(app.sessions);
  const fault = vi
    .spyOn(app.sessions, 'mutate')
    .mockImplementation((id, type, ...args) =>
      type === 'file.restored'
        ? Promise.reject(new Error('Отказ журнала после отката'))
        : mutate(id, type, ...args),
    );
  await expect(files.restore(run.runId, changeId, preview.previewToken)).rejects.toThrow(
    'Отказ журнала',
  );
  fault.mockRestore();
  return { ...app, ...run, path, files, changeId, provider };
}

it.each([true, false])(
  'человек подтверждает завершённый откат existing=%s после восстановления сервиса',
  async (existing) => {
    const app = await interrupted(existing);
    const sessions = new FileSessionStore(app.sessions.directory);
    await sessions.initialize();
    const files = new FileChanges(sessions);
    const preview = await files.previewResolution(app.runId, app.changeId);
    expect(preview).toMatchObject({ outcome: 'restored', exists: existing });
    const channel = {
      sessions,
      runtime: app.runtime,
      scheduler: new ToolScheduler(1),
    } as Application;
    await expect(
      fileCommand(channel, 'files.resolveRestore', {
        runId: app.runId,
        changeId: app.changeId,
        previewToken: preview.previewToken,
        result: 'Исходное состояние проверено',
      }),
    ).resolves.toEqual({ resolved: true });
    expect(sessions.get(app.runId).fileChanges![0]).toMatchObject({
      status: 'restored',
      resolution: { result: 'Исходное состояние проверено' },
    });
    await expect(
      files.resolveRestore(app.runId, app.changeId, preview.previewToken, 'Повтор'),
    ).rejects.toThrow('больше не требует');
    if (existing) expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
    else await expect(readFile(app.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = new FileSessionStore(sessions.directory);
    await restarted.initialize();
    expect(restarted.get(app.runId).fileChanges![0]!.status).toBe('restored');
  },
);

it.each(['Новая версия', 'Частичный откат'])(
  'проверка сохраняет фактическое содержимое: %s',
  async (content) => {
    const app = await interrupted();
    await writeFile(app.path, content);
    await expect(
      app.runtime.start({
        message: 'Продолжи',
        workspace: app.workspace,
        sessionId: app.sessionId,
        requestKey: 'blocked',
      }),
    ).rejects.toThrow('неизвестным результатом');
    const preview = await app.files.previewResolution(app.runId, app.changeId);
    expect(preview.outcome).toBe(content === 'Новая версия' ? 'applied' : 'reviewed');
    await app.files.resolveRestore(
      app.runId,
      app.changeId,
      preview.previewToken,
      'Проверил содержимое, оставляю как есть',
    );
    expect(await readFile(app.path, 'utf8')).toBe(content);
    const next = await app.runtime.start({
      message: 'Продолжи',
      workspace: app.workspace,
      sessionId: app.sessionId,
      requestKey: 'after-review',
    });
    await app.runtime.wait(next.runId);
    expect(
      app.provider.requests
        .at(-1)!
        .messages.some((message) =>
          message.content.includes('Проверил содержимое, оставляю как есть'),
        ),
    ).toBe(true);
  },
);

it('изменение и удаление файла после проверки отклоняют устаревшее подтверждение', async () => {
  const app = await interrupted();
  const first = await app.files.previewResolution(app.runId, app.changeId);
  await writeFile(app.path, 'Внешняя правка');
  await expect(
    app.files.resolveRestore(app.runId, app.changeId, first.previewToken, 'Проверено'),
  ).rejects.toThrow('Файл изменился');
  const second = await app.files.previewResolution(app.runId, app.changeId);
  await unlink(app.path);
  await expect(
    app.files.resolveRestore(app.runId, app.changeId, second.previewToken, 'Проверено'),
  ).rejects.toThrow('Файл изменился');
  expect(app.sessions.get(app.runId).fileChanges![0]!.status).toBe('restoring');
  await expect(
    app.files.resolveRestore(app.runId, app.changeId, second.previewToken, '  '),
  ).rejects.toThrow();
});

it('успешный повтор отката не приписывает старую ручную оценку новому результату', async () => {
  const app = await interrupted();
  await writeFile(app.path, 'Новая версия');
  const review = await app.files.previewResolution(app.runId, app.changeId);
  await app.files.resolveRestore(
    app.runId,
    app.changeId,
    review.previewToken,
    'Откат не выполнен, сохранилась новая версия',
  );
  const preview = await app.files.previewRestore(app.runId, app.changeId);
  await app.files.restore(app.runId, app.changeId, preview.previewToken);
  const change = app.sessions.get(app.runId).fileChanges![0]!;
  expect(change.status).toBe('restored');
  expect(change.resolution).toBeUndefined();
  expect(
    app.sessions.history(app.runId, 0).find((event) => event.type === 'file.restore_resolved')!
      .state.fileChanges![0]!.resolution?.result,
  ).toBe('Откат не выполнен, сохранилась новая версия');
  const next = await app.runtime.start({
    message: 'Проверь текущее состояние',
    workspace: app.workspace,
    sessionId: app.sessionId,
    requestKey: 'after-repeated-restore',
  });
  await app.runtime.wait(next.runId);
  const corrections = app.provider.requests
    .at(-1)!
    .messages.filter((message) => message.content.startsWith('[Harness:'));
  expect(corrections.at(-1)!.content).toContain('пользователь восстановил');
  expect(corrections.at(-1)!.content).not.toContain('Откат не выполнен');
  expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
});

it('проверка снимает блокировку полного удаления, не затрагивая рабочий файл', async () => {
  const app = await interrupted();
  const learning = new LearningService(
    app.learning,
    app.sessions,
    app.snapshot.value,
    app.provider,
    app.policy,
    () => app.runtime.busy(),
  );
  const purge = new SessionPurge(
    app.sessions,
    learning,
    app.learning,
    app.runtime,
    new ToolScheduler(1),
  );
  expect(await purge.preview(app.runId)).toMatchObject({ available: false });
  const preview = await app.files.previewResolution(app.runId, app.changeId);
  await app.files.resolveRestore(
    app.runId,
    app.changeId,
    preview.previewToken,
    'Файл восстановлен, проверено',
  );
  const removal = await purge.preview(app.runId);
  expect(removal.available).toBe(true);
  await purge.purge(app.runId, removal.previewToken);
  expect(app.sessions.list(true)).toEqual([]);
  expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
});

it('resume ждёт проверки отката старого этапа и получает подтверждённый результат', async () => {
  const app = await interrupted();
  const agent = newAgent('coordinator', 'Продолжение из старого журнала');
  const legacy = {
    ...app.sessions.get(app.runId),
    id: randomUUID(),
    parentRunId: app.runId,
    requestKey: 'legacy-restore',
    requestHash: 'legacy-restore',
    rootAgentId: agent.id,
    agents: { [agent.id]: agent },
    invocations: {},
    fileChanges: [],
    status: 'paused' as const,
  };
  await appendJournal(join(app.sessions.directory, 'runs', legacy.id + '.jsonl'), {
    seq: 1,
    at: legacy.createdAt,
    type: 'run.created',
    payload: {},
    state: legacy,
  });
  await app.sessions.initialize();
  await expect(app.runtime.resume(legacy.id)).rejects.toThrow('неизвестным результатом');
  expect(app.provider.requests).toHaveLength(2);
  expect(app.sessions.get(legacy.id).status).toBe('paused');
  const preview = await app.files.previewResolution(app.runId, app.changeId);
  await app.files.resolveRestore(
    app.runId,
    app.changeId,
    preview.previewToken,
    'Откат проверен: исходное содержимое восстановлено',
  );
  await app.runtime.resume(legacy.id);
  await app.runtime.wait(legacy.id);
  expect(app.sessions.get(legacy.id).status).toBe('completed');
  expect(
    app.provider.requests
      .at(-1)!
      .messages.some((message) =>
        message.content.includes('Откат проверен: исходное содержимое восстановлено'),
      ),
  ).toBe(true);
  expect(await readFile(app.path, 'utf8')).toBe('Исходная версия');
});
