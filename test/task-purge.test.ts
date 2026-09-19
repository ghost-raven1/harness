import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile, symlink, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { cleanup, eventually } from './helpers.js';
import { fixture, files, preview, purge, sourceText, privateKey } from './purge-fixture.js';

afterEach(() => vi.restoreAllMocks());

it('preview показывает всю беседу и связанные данные; просмотр и неверный token ничего не удаляют', async () => {
  const item = await fixture();
  const before = await files(item.directory);
  const plan = await preview(item.app, item.next.runId);
  expect(plan).toMatchObject({
    sessionId: item.first.sessionId,
    runs: 2,
    artifacts: 1,
    backups: 1,
    lessons: 1,
    evidence: 1,
    exports: 1,
    available: true,
    blockers: [],
  });
  expect(new Set(plan.runIds)).toEqual(new Set([item.first.runId, item.next.runId]));
  expect(await files(item.directory)).toEqual(before);
  await expect(
    dispatch(item.app, 'runtime.purge', { runId: item.next.runId, previewToken: '0'.repeat(64) }),
  ).rejects.toThrow('изменился');
  expect(await files(item.directory)).toEqual(before);
});

it('удаляет историю, скрытое продолжение, поток, уроки и копии из всего state; workspace и квота остаются', async () => {
  const item = await fixture();
  const quota = await readFile(join(item.directory, 'usage.json'), 'utf8');
  const plan = await preview(item.app, item.next.runId);
  const [result, repeated] = await Promise.all(
    [0, 1].map(() =>
      dispatch(item.app, 'runtime.purge', {
        runId: item.next.runId,
        previewToken: plan.previewToken,
      }),
    ),
  );
  expect(repeated).toEqual(result);
  expect(result).toEqual({ purged: true, sessionId: item.first.sessionId, runs: 2 });
  expect(item.app.sessions.list(true).map((run) => run.id)).toEqual([item.other.runId]);
  expect(() => item.app.sessions.get(item.first.runId)).toThrow('Unknown run');
  expect((await item.app.sessions.output.page(item.next.runId, 0)).events).toEqual([]);
  const stored = JSON.stringify(await files(item.directory));
  expect(stored).not.toContain(sourceText);
  expect(stored).not.toContain(privateKey);
  expect(stored).toContain('Остальная задача');
  expect(await readFile(join(item.directory, 'usage.json'), 'utf8')).toBe(quota);
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
  expect(
    await readFile(join(item.workspace, 'Ответ Harness ' + item.first.runId + '.md'), 'utf8'),
  ).toBe(sourceText);
  expect(item.learning.read().releases.learned?.candidateIds).toEqual([]);
  expect(item.learning.lessons('learned', item.workspace, 'coordinator', 'test')).toEqual([]);
  expect(
    await dispatch(item.app, 'runtime.purge', {
      runId: item.next.runId,
      previewToken: plan.previewToken,
    }),
  ).toEqual(result);
});

it('изменившаяся история или новый урок требуют свежего подтверждения', async () => {
  const item = await fixture();
  const old = await preview(item.app, item.first.runId);
  await item.app.learning.feedback(item.next.runId, true, 'Дополнительная проверка');
  await expect(
    dispatch(item.app, 'runtime.purge', {
      runId: item.first.runId,
      previewToken: old.previewToken,
    }),
  ).rejects.toThrow('предпросмотр');
  const changed = await preview(item.app, item.first.runId);
  expect(changed.evidence).toBe(2);
  await item.app.sessions.mutate(item.next.runId, 'test.changed', {}, (run) => {
    run.result = 'Свежий ответ';
  });
  await expect(
    dispatch(item.app, 'runtime.purge', {
      runId: item.first.runId,
      previewToken: changed.previewToken,
    }),
  ).rejects.toThrow('предпросмотр');
  expect(item.app.sessions.list(true)).toHaveLength(3);
});

it('не удаляет ни одной записи при текущей работе, неизвестной записи или проверке урока', async () => {
  const item = await fixture();
  const before = await files(item.directory);
  const busy = vi.spyOn(item.app.runtime, 'busy').mockReturnValue(true);
  expect((await preview(item.app, item.first.runId)).available).toBe(false);
  await expect(purge(item.app, item.first.runId)).rejects.toThrow('остановите');
  busy.mockRestore();
  const learningBusy = vi.spyOn(item.app.learning, 'busy').mockReturnValue(true);
  await expect(purge(item.app, item.first.runId)).rejects.toThrow('проверяется урок');
  learningBusy.mockRestore();
  expect(await files(item.directory)).toEqual(before);
  await item.app.sessions.mutate(item.next.runId, 'test.unknown', {}, (run) => {
    run.invocations.unknown = {
      id: 'unknown',
      agentId: run.rootAgentId,
      call: { id: 'unknown', name: 'fs.write', arguments: '{}' },
      effect: 'write',
      status: 'unknown',
      startedAt: new Date().toISOString(),
    };
  });
  const unknown = await files(item.directory);
  await expect(purge(item.app, item.first.runId)).rejects.toThrow('неизвестным');
  expect(await files(item.directory)).toEqual(unknown);
});

it('во время очистки запрещены новый запуск, resume и feedback; очередь обучения не начинает работу', async () => {
  const item = await fixture();
  await item.app.sessions.mutate(item.other.runId, 'test.paused', {}, (run) => {
    run.status = 'paused';
  });
  const original = item.learning.purge.bind(item.learning);
  let entered = false,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(item.learning, 'purge').mockImplementation(async (record) => {
    entered = true;
    await waiting;
    await original(record);
  });
  const plan = await preview(item.app, item.first.runId);
  const removing = dispatch(item.app, 'runtime.purge', {
    runId: item.first.runId,
    previewToken: plan.previewToken,
  });
  await eventually(() => entered);
  await expect(
    item.app.runtime.start({
      message: 'Новая задача',
      workspace: item.workspace,
      requestKey: 'during-purge',
    }),
  ).rejects.toThrow('Удаляется беседа');
  await expect(item.app.runtime.resume(item.other.runId)).rejects.toThrow('Удаляется беседа');
  await expect(item.app.learning.feedback(item.next.runId, true, 'Поздний отзыв')).rejects.toThrow(
    'Удаляется беседа',
  );
  expect(await item.app.learning.processNext()).toBe(false);
  release();
  await removing;
  expect(item.app.sessions.get(item.other.runId).status).toBe('paused');
});

it('startup завершает каскад после сбоя и не воскрешает текст из старого snapshot или временного файла', async () => {
  const item = await fixture();
  const oldLearning = await readFile(join(item.directory, 'learning.json'), 'utf8');
  await writeFile(join(item.directory, 'runs', item.first.runId + '.json.123abc.tmp'), sourceText);
  await writeFile(join(item.directory, 'learning.json.123abc.tmp'), sourceText);
  const original = item.learning.purge.bind(item.learning);
  vi.spyOn(item.learning, 'purge').mockImplementation(async (record) => {
    await original(record);
    await writeFile(join(item.directory, 'learning.json'), oldLearning);
    throw new Error('Проверяем аварию между этапами');
  });
  await expect(purge(item.app, item.first.runId)).rejects.toThrow('Перезапустите');
  await expect(
    item.app.runtime.start({
      message: 'Попытка во время сбоя',
      workspace: item.workspace,
      requestKey: 'blocked-after-crash',
    }),
  ).rejects.toThrow('Удаляется беседа');
  await item.app.close();
  const restored = await createApplication(item.configFile, item.directory, item.provider);
  cleanup(() => restored.close());
  expect(restored.sessions.list(true).map((run) => run.id)).toEqual([item.other.runId]);
  expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
  await expect(
    restored.runtime.start({
      message: sourceText,
      workspace: item.workspace,
      requestKey: privateKey,
    }),
  ).rejects.toThrow('удалена навсегда');
  await expect(
    restored.runtime.start({
      message: 'Ещё вопрос',
      workspace: item.workspace,
      requestKey: 'new-key',
      sessionId: item.first.sessionId,
    }),
  ).rejects.toThrow('удалена навсегда');
});

it('старый ключ удалённого запроса запрещён и после обычного перезапуска', async () => {
  const item = await fixture();
  await purge(item.app, item.first.runId);
  await item.app.close();
  const restored = await createApplication(item.configFile, item.directory, item.provider);
  cleanup(() => restored.close());
  await expect(
    restored.runtime.start({
      message: sourceText,
      workspace: item.workspace,
      requestKey: privateKey,
    }),
  ).rejects.toThrow('удалена навсегда');
  await expect(
    restored.runtime.start({
      message: 'Другой текст',
      workspace: item.workspace,
      requestKey: 'followup',
    }),
  ).rejects.toThrow('удалена навсегда');
  expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
});

it('удаляет зависимые проверки и уроки, сохраняя независимые знания и права другой задачи на паузе', async () => {
  const item = await fixture();
  await item.learning.update((state) => {
    state.candidates.dependent = {
      ...state.candidates.sourceLesson!,
      id: 'dependent',
      sourceRunId: item.other.runId,
      title: 'Зависимый урок',
      lesson: 'Основан на прежней версии',
      evidenceIds: [],
    };
    state.reports.dependent = {
      candidateId: 'dependent',
      baselineVersion: 'learned',
      suiteHash: 'dependent',
      results: [],
      passed: true,
    };
    state.candidates.independent = {
      ...state.candidates.dependent!,
      id: 'independent',
      title: 'Независимый урок',
      lesson: 'Не использовал удаляемый опыт',
    };
    state.reports.independent = {
      candidateId: 'independent',
      baselineVersion: 'baseline',
      suiteHash: 'independent',
      results: [],
      passed: true,
    };
    state.releases.next = {
      id: 'next',
      parentId: 'learned',
      createdAt: new Date().toISOString(),
      candidateIds: ['sourceLesson', 'dependent', 'independent'],
    };
    state.activeVersion = 'next';
  });
  await item.app.sessions.mutate(item.other.runId, 'test.pinned', {}, (run) => {
    run.status = 'paused';
    run.learningVersion = 'next';
  });
  expect((await preview(item.app, item.first.runId)).blockers.join('\n')).toContain('на паузе');
  await item.app.runtime.cancel(item.other.runId);
  expect((await preview(item.app, item.first.runId)).lessons).toBe(2);
  await purge(item.app, item.first.runId);
  expect(Object.keys(item.learning.read().candidates)).toEqual(['independent']);
  expect(item.learning.read().releases.next?.candidateIds).toEqual(['independent']);
  expect(item.app.sessions.get(item.other.runId).learningVersion).toBe('next');
});

it('удаляет внутреннюю ссылку экспорта, не следуя за ней к файлу проекта', async () => {
  const item = await fixture();
  const exported = join(item.directory, 'exports', 'Урок Harness sourceLesson.md');
  await unlink(exported);
  await symlink(join(item.workspace, 'project.txt'), exported);
  expect((await preview(item.app, item.first.runId)).exports).toBe(1);
  await purge(item.app, item.first.runId);
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
});

it('каталог экспорта со ссылкой на workspace блокирует удаление до изменения данных', async () => {
  const item = await fixture();
  await rename(join(item.directory, 'exports'), join(item.root, 'original-exports'));
  await symlink(item.workspace, join(item.directory, 'exports'));
  const before = await files(item.directory);
  await expect(purge(item.app, item.first.runId)).rejects.toThrow('заменены ссылками');
  expect(await files(item.directory)).toEqual(before);
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
});

it('экспорт и удаление используют одну очередь; поздний экспорт не воскрешает удалённый урок', async () => {
  const item = await fixture();
  const id = '3e5575be-7428-4f5e-ae43-16ef3e876be2';
  await unlink(join(item.directory, 'exports', 'Урок Harness sourceLesson.md'));
  await item.learning.update((state) => {
    state.candidates[id] = { ...state.candidates.sourceLesson!, id };
    state.reports[id] = { ...state.reports.sourceLesson!, candidateId: id };
    delete state.candidates.sourceLesson;
    delete state.reports.sourceLesson;
    state.releases.learned!.candidateIds = [id];
    state.jobs[0]!.candidateId = id;
  });
  const old = await preview(item.app, item.first.runId);
  const exported = (await dispatch(item.app, 'learning.export', { id })) as { path: string };
  expect(await readFile(exported.path, 'utf8')).toContain(sourceText);
  expect(await dispatch(item.app, 'learning.export', { id })).toEqual({
    path: exported.path,
    exists: true,
  });
  await expect(
    dispatch(item.app, 'runtime.purge', {
      runId: item.first.runId,
      previewToken: old.previewToken,
    }),
  ).rejects.toThrow('изменился');
  const plan = await preview(item.app, item.first.runId);
  let release!: () => void;
  const barrier = item.app.scheduler.schedule(
    'write',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let enqueued!: () => void;
  const admitted = new Promise<void>((resolve) => {
    enqueued = resolve;
  });
  const schedule = item.app.scheduler.schedule.bind(item.app.scheduler);
  vi.spyOn(item.app.scheduler, 'schedule').mockImplementationOnce((effect, work, signal) => {
    const queued = schedule(effect, work, signal);
    enqueued();
    return queued;
  });
  const removing = dispatch(item.app, 'runtime.purge', {
    runId: item.first.runId,
    previewToken: plan.previewToken,
  });
  // Проектная очередь берётся раньше диспетчера; проверяем порядок уже поставленных операций.
  await admitted;
  const lateExport = expect(dispatch(item.app, 'learning.export', { id })).rejects.toThrow(
    'Урок уже удалён',
  );
  release();
  await barrier;
  await removing;
  await lateExport;
  expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
});

it.each(['intent', 'files'] as const)(
  'восстанавливает удаление после остановки на этапе %s',
  async (phase) => {
    const item = await fixture();
    if (phase === 'intent') {
      vi.spyOn(item.learning, 'purge').mockRejectedValueOnce(new Error('Сбой до очистки обучения'));
    } else {
      const original = item.app.sessions.purgeFiles.bind(item.app.sessions);
      vi.spyOn(item.app.sessions, 'purgeFiles').mockImplementationOnce(async (record) => {
        await original(record);
        throw new Error('Сбой после удаления файлов');
      });
    }
    await expect(purge(item.app, item.first.runId)).rejects.toThrow('Перезапустите');
    await item.app.close();
    const restored = await createApplication(item.configFile, item.directory, item.provider);
    cleanup(() => restored.close());
    expect(restored.sessions.list(true).map((run) => run.id)).toEqual([item.other.runId]);
    expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
    await expect(
      restored.runtime.start({
        message: 'Не повторять',
        workspace: item.workspace,
        requestKey: privateKey,
      }),
    ).rejects.toThrow('удалена навсегда');
  },
);

it.each(['cancelled', 'failed', 'paused'] as const)(
  'проверка неизвестного эффекта у %s снимает блокировку удаления, сохраняя статус',
  async (status) => {
    const item = await fixture();
    await item.app.sessions.mutate(item.first.runId, 'test.unknown', {}, (run) => {
      run.status = status;
      run.invocations.unknown = {
        id: 'unknown',
        agentId: run.rootAgentId,
        call: { id: 'unknown', name: 'fs.write', arguments: '{}' },
        effect: 'write',
        status: 'unknown',
        startedAt: new Date().toISOString(),
      };
    });
    expect((await preview(item.app, item.next.runId)).available).toBe(false);
    await expect(
      item.app.runtime.start({
        message: 'Продолжить',
        workspace: item.workspace,
        sessionId: item.first.sessionId,
        requestKey: 'unknown-followup',
      }),
    ).rejects.toThrow('неизвестным результатом');
    await item.app.runtime.resolveInvocation(
      item.first.runId,
      'unknown',
      'Файл проверен: запись выполнена',
      true,
    );
    expect(item.app.sessions.get(item.first.runId).status).toBe(status);
    expect(item.app.sessions.get(item.first.runId).invocations.unknown?.status).toBe('succeeded');
    expect((await preview(item.app, item.next.runId)).available).toBe(true);
    await purge(item.app, item.next.runId);
    expect(item.app.sessions.list(true)).toHaveLength(1);
  },
);

it('попытка удаления работающей задачи не прерывает её запись состояния', async () => {
  const item = await fixture();
  const plan = await preview(item.app, item.first.runId);
  await item.app.sessions.mutate(item.other.runId, 'test.running', {}, (run) => {
    run.status = 'running';
  });
  const removing = expect(
    dispatch(item.app, 'runtime.purge', {
      runId: item.first.runId,
      previewToken: plan.previewToken,
    }),
  ).rejects.toThrow('остановите');
  await item.app.sessions.mutate(item.other.runId, 'test.progress', {}, (run) => {
    run.turns++;
  });
  await removing;
  expect(item.app.sessions.get(item.other.runId).turns).toBeGreaterThan(0);
  expect(item.app.sessions.list(true)).toHaveLength(3);
});
