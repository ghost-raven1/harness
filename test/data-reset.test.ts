import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import type { DataResetScope } from '../src/application/data-reset.js';
import { cleanup, eventually } from './helpers.js';
import { fixture, files, privateKey, sourceText } from './purge-fixture.js';

const scopes: DataResetScope[] = ['tasks', 'learning', 'all'];
afterEach(() => vi.restoreAllMocks());

it('предпросмотр показывает выбранный состав, а просмотр или неверный scope/token ничего не изменяют', async () => {
  const item = await fixture();
  const before = await files(item.directory);
  const tasks = await item.app.reset.preview('tasks');
  const learning = await item.app.reset.preview('learning');
  const all = await item.app.reset.preview('all');
  expect(tasks).toMatchObject({
    scope: 'tasks',
    tasks: 3,
    sessions: 2,
    lessons: 0,
    evidence: 0,
    jobs: 1,
    artifacts: 1,
    backups: 1,
    exports: 0,
    available: true,
  });
  expect(learning).toMatchObject({
    scope: 'learning',
    tasks: 0,
    sessions: 0,
    lessons: 1,
    evidence: 1,
    jobs: 1,
    artifacts: 0,
    backups: 0,
    exports: 1,
    available: true,
  });
  expect(all).toMatchObject({
    scope: 'all',
    tasks: 3,
    sessions: 2,
    lessons: 1,
    evidence: 1,
    jobs: 1,
    artifacts: 1,
    backups: 1,
    exports: 1,
    available: true,
  });
  expect(new Set([tasks.previewToken, learning.previewToken, all.previewToken]).size).toBe(3);
  await expect(item.app.reset.reset('tasks', all.previewToken)).rejects.toThrow('изменился');
  await expect(item.app.reset.reset('all', '0'.repeat(64))).rejects.toThrow('изменился');
  expect(await files(item.directory)).toEqual(before);
});

it.each(scopes)(
  '%s: удаляет выбранный слой, сохраняя рабочие файлы, настройки, ключи и числовую квоту',
  async (scope) => {
    const item = await fixture();
    await mkdir(join(item.directory, 'settings'), { recursive: true });
    const settings = join(item.directory, 'settings', 'profiles.json');
    await writeFile(settings, '{"apiKeyEnv":"TEST_API_KEY","model":"test"}');
    const credential = join(item.directory, 'private.env');
    await writeFile(credential, 'TEST_API_KEY=fixture-private-key');
    await item.learning.update((state) => {
      state.daily = { date: '2026-09-12', tokens: 987 };
      state.paused = true;
    });
    const oldLearning = item.learning.read();
    const oldRuns = item.app.sessions.list(true);
    const quota = await readFile(join(item.directory, 'usage.json'), 'utf8');
    const plan = await item.app.reset.preview(scope);
    const [result, repeated] = await Promise.all(
      [0, 1].map(() => item.app.reset.reset(scope, plan.previewToken)),
    );
    expect(result).toEqual({
      reset: true,
      scope,
      tasks: scope === 'learning' ? 0 : 3,
      sessions: scope === 'learning' ? 0 : 2,
    });
    expect(repeated).toEqual(result);
    expect(await readFile(settings, 'utf8')).toContain('TEST_API_KEY');
    expect(await readFile(credential, 'utf8')).toBe('TEST_API_KEY=fixture-private-key');
    expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
    expect(
      await readFile(join(item.workspace, 'Ответ Harness ' + item.first.runId + '.md'), 'utf8'),
    ).toBe(sourceText);
    expect(await readFile(join(item.directory, 'usage.json'), 'utf8')).toBe(quota);
    expect(item.learning.read().daily).toEqual(oldLearning.daily);
    expect(item.learning.read().paused).toBe(true);
    if (scope === 'learning') {
      expect(item.app.sessions.list(true)).toEqual(oldRuns);
      const artifact = Object.keys(
        await files(join(item.directory, 'artifacts', item.first.runId)),
      )[0]!;
      expect(
        await item.app.sessions.readArtifact(item.first.runId, basename(artifact, '.txt'), 0, 100),
      ).toBe(sourceText);
    } else {
      expect(item.app.sessions.list(true)).toEqual([]);
      const stateFiles = Object.keys(await files(item.directory));
      expect(stateFiles.some((name) => /\/(runs|output|artifacts|file-backups)\//.test(name))).toBe(
        false,
      );
      await expect(
        item.app.runtime.start({
          message: sourceText,
          workspace: item.workspace,
          requestKey: privateKey,
        }),
      ).rejects.toThrow('удалена навсегда');
    }
    const learned = item.learning.read();
    if (scope === 'tasks') {
      expect(learned).toEqual({ ...oldLearning, jobs: [] });
      expect(
        await readFile(join(item.directory, 'exports', 'Урок Harness sourceLesson.md'), 'utf8'),
      ).toBe(sourceText);
    } else {
      expect(learned).toMatchObject({
        activeVersion: 'baseline',
        candidates: {},
        evidence: {},
        reports: {},
        jobs: [],
        releases: { baseline: { candidateIds: [] } },
      });
      expect(Object.keys(learned.releases)).toEqual(['baseline']);
      expect(
        Object.keys(await files(item.directory)).some((path) => path.includes('Урок Harness')),
      ).toBe(false);
      expect(await readFile(join(item.directory, 'learning.jsonl'), 'utf8')).not.toContain(
        sourceText,
      );
      expect(await readFile(join(item.directory, 'learning.json'), 'utf8')).not.toContain(
        sourceText,
      );
    }
    if (scope === 'all')
      expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
  },
);

it('изменение данных после просмотра требует нового подтверждения', async () => {
  const item = await fixture();
  const plan = await item.app.reset.preview('all');
  await item.app.learning.feedback(item.next.runId, true, 'Новый проверенный источник');
  await expect(item.app.reset.reset('all', plan.previewToken)).rejects.toThrow('предпросмотр');
  expect(item.app.sessions.list(true)).toHaveLength(3);
});

it('занятая модель или обучение блокируют сброс до изменения файлов', async () => {
  const item = await fixture();
  const before = await files(item.directory);
  const modelBusy = vi.spyOn(item.app.runtime, 'busy').mockReturnValue(true);
  const first = await item.app.reset.preview('all');
  expect(first.available).toBe(false);
  await expect(item.app.reset.reset('all', first.previewToken)).rejects.toThrow('остановите');
  modelBusy.mockRestore();
  const learningBusy = vi.spyOn(item.app.learning, 'busy').mockReturnValue(true);
  const second = await item.app.reset.preview('learning');
  expect(second.available).toBe(false);
  await expect(item.app.reset.reset('learning', second.previewToken)).rejects.toThrow(
    'проверяется урок',
  );
  learningBusy.mockRestore();
  expect(await files(item.directory)).toEqual(before);
});

it('неизвестные эффекты защищают удаляемые задачи, а закреплённая версия — сохраняемую задачу на паузе', async () => {
  const item = await fixture();
  await item.app.sessions.mutate(item.next.runId, 'test.unknown', {}, (run) => {
    run.status = 'paused';
    run.invocations.unknown = {
      id: 'unknown',
      agentId: run.rootAgentId,
      call: { id: 'unknown', name: 'fs.write', arguments: '{}' },
      effect: 'write',
      status: 'unknown',
      startedAt: new Date().toISOString(),
    };
  });
  expect((await item.app.reset.preview('tasks')).available).toBe(false);
  expect((await item.app.reset.preview('all')).available).toBe(false);
  expect((await item.app.reset.preview('learning')).available).toBe(true);
  await item.app.runtime.resolveInvocation(item.next.runId, 'unknown', 'Проверено вручную', true);
  await item.app.sessions.mutate(item.next.runId, 'test.pinned', {}, (run) => {
    run.learningVersion = 'learned';
  });
  expect((await item.app.reset.preview('learning')).blockers.join('\n')).toContain('на паузе');
  expect((await item.app.reset.preview('all')).available).toBe(true);
  const plan = await item.app.reset.preview('all');
  await item.app.reset.reset('all', plan.previewToken);
  expect(item.app.sessions.list(true)).toEqual([]);
});

it('во время сброса нельзя создать задачу, продолжить паузу или записать отзыв', async () => {
  const item = await fixture();
  await item.app.sessions.mutate(item.other.runId, 'test.paused', {}, (run) => {
    run.status = 'paused';
  });
  let entered = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = item.learning.reset.bind(item.learning);
  vi.spyOn(item.learning, 'reset').mockImplementationOnce(async (options) => {
    entered = true;
    await gate;
    await original(options);
  });
  const plan = await item.app.reset.preview('learning');
  const clearing = item.app.reset.reset('learning', plan.previewToken);
  await eventually(() => entered);
  await expect(
    item.app.runtime.start({
      message: 'Новая задача',
      workspace: item.workspace,
      requestKey: 'while-reset',
    }),
  ).rejects.toThrow('Удаляется');
  await expect(item.app.runtime.resume(item.other.runId)).rejects.toThrow('Удаляется');
  await expect(item.app.learning.feedback(item.next.runId, true, 'Новый отзыв')).rejects.toThrow(
    'Удаляется',
  );
  expect(await item.app.learning.processNext()).toBe(false);
  release();
  await clearing;
});

it.each(scopes)(
  '%s: перезапуск завершает прерванный сброс и сохраняет выбранную семантику',
  async (scope) => {
    const item = await fixture();
    const oldState = item.learning.read();
    const original = item.learning.reset.bind(item.learning);
    vi.spyOn(item.learning, 'reset').mockImplementationOnce(async (options) => {
      await original(options);
      throw new Error('Проверочная авария после очистки журнала');
    });
    const plan = await item.app.reset.preview(scope);
    await expect(item.app.reset.reset(scope, plan.previewToken)).rejects.toThrow('Перезапустите');
    await expect(
      item.app.runtime.start({
        message: 'До восстановления',
        workspace: item.workspace,
        requestKey: 'blocked',
      }),
    ).rejects.toThrow('Удаляется');
    await item.app.close();
    const restored = await createApplication(item.configFile, item.directory, item.provider);
    cleanup(() => restored.close());
    expect(restored.sessions.list(true)).toHaveLength(scope === 'learning' ? 3 : 0);
    if (scope === 'tasks')
      expect(restored.learning.store.read()).toEqual({ ...oldState, jobs: [] });
    else
      expect(restored.learning.store.read()).toMatchObject({
        activeVersion: 'baseline',
        candidates: {},
        evidence: {},
        reports: {},
        jobs: [],
      });
    if (scope !== 'learning')
      await expect(
        restored.runtime.start({
          message: sourceText,
          workspace: item.workspace,
          requestKey: privateKey,
        }),
      ).rejects.toThrow('удалена навсегда');
    if (scope === 'all')
      expect(JSON.stringify(await files(item.directory))).not.toContain(sourceText);
    expect(await restored.reset.reset(scope, plan.previewToken)).toMatchObject({
      reset: true,
      scope,
    });
  },
);

it('старые сохранённые задачи не наполняют обучение заново после очистки и перезапуска', async () => {
  const item = await fixture();
  await writeFile(
    join(item.root, 'config', 'learning.json'),
    JSON.stringify({ enabled: true, cases: [] }),
  );
  await item.app.sessions.mutate(item.next.runId, 'test.source', {}, (run) => {
    run.config.value.learning.enabled = true;
    run.invocations.verified = {
      id: 'verified',
      agentId: run.rootAgentId,
      role: 'coordinator',
      call: { id: 'verified', name: 'fs.read', arguments: '{}' },
      effect: 'read',
      status: 'succeeded',
      result: 'Проверенные старые данные',
      startedAt: new Date().toISOString(),
    };
  });
  await item.app.learning.enqueue(item.next.runId);
  expect(item.learning.read().jobs.length).toBeGreaterThan(1);
  const plan = await item.app.reset.preview('learning');
  await item.app.reset.reset('learning', plan.previewToken);
  await item.app.learning.enqueue(item.next.runId);
  expect(item.learning.read().jobs).toEqual([]);
  await item.app.close();
  const restored = await createApplication(item.configFile, item.directory, item.provider);
  cleanup(() => restored.close());
  expect(restored.learning.store.read().jobs).toEqual([]);
  expect(restored.learning.store.read().evidence).toEqual({});
  await restored.learning.feedback(item.next.runId, true, 'Новая явная обратная связь');
  expect(restored.learning.store.read().jobs).toHaveLength(1);
});

it('очищает штатный экспорт-ссылку и старый экспорт без урока, не удаляя файл за ссылкой', async () => {
  const item = await fixture();
  const orphan = join(item.directory, 'exports', 'Урок Harness old-lesson.md');
  await symlink(join(item.workspace, 'project.txt'), orphan);
  await writeFile(join(item.directory, 'exports', 'Мои заметки.md'), 'Сохранить');
  const plan = await item.app.reset.preview('learning');
  expect(plan.exports).toBe(2);
  await item.app.reset.reset('learning', plan.previewToken);
  expect(await readFile(join(item.workspace, 'project.txt'), 'utf8')).toContain(sourceText);
  expect(await readFile(join(item.directory, 'exports', 'Мои заметки.md'), 'utf8')).toBe(
    'Сохранить',
  );
});

it('каталог exports со ссылкой на workspace блокирует все режимы без удаления', async () => {
  const item = await fixture();
  await rename(join(item.directory, 'exports'), join(item.root, 'saved-exports'));
  await symlink(item.workspace, join(item.directory, 'exports'));
  const before = await files(item.directory);
  for (const scope of scopes) {
    const plan = await item.app.reset.preview(scope);
    expect(plan.available).toBe(false);
    await expect(item.app.reset.reset(scope, plan.previewToken)).rejects.toThrow(
      'заменены ссылками',
    );
  }
  expect(await files(item.directory)).toEqual(before);
});

it.each(['resets', 'purged'])(
  'подмена каталога маркеров %s блокирует чтение, сброс и восстановление без записи в workspace',
  async (folder) => {
    const item = await fixture();
    const beforeWorkspace = await files(item.workspace);
    await symlink(item.workspace, join(item.directory, folder));
    const beforeState = await files(item.directory);
    const plan = await item.app.reset.preview('all');
    expect(plan.available).toBe(false);
    await expect(item.app.reset.reset('all', plan.previewToken)).rejects.toThrow('ссылк');
    expect(await files(item.directory)).toEqual(beforeState);
    expect(await files(item.workspace)).toEqual(beforeWorkspace);
    await item.app.close();
    const diagnostic = await createApplication(item.configFile, item.directory, item.provider);
    expect(diagnostic.sessions.recoveryError).toContain('ссылк');
    expect(() => diagnostic.sessions.assertWritable()).toThrow('ссылк');
    await diagnostic.close();
    expect(await files(item.workspace)).toEqual(beforeWorkspace);
  },
);

it('tasks/all очищают файлы после аварии вне индекса, а learning оставляет их в истории задач', async () => {
  const item = await fixture();
  await mkdir(join(item.directory, 'artifacts', 'orphan'), { recursive: true });
  await writeFile(
    join(item.directory, 'artifacts', 'orphan', 'lost.txt'),
    'Неиндексированный ответ',
  );
  await writeFile(join(item.directory, 'runs', 'unfinished.tmp'), 'Незавершённый снимок');
  for (const folder of ['indexes', 'search']) {
    await mkdir(join(item.directory, folder), { recursive: true });
    await writeFile(join(item.directory, folder, 'orphan.tmp'), 'Удаляемый производный текст');
  }
  const plan = await item.app.reset.preview('tasks');
  expect(plan.artifacts).toBe(2);
  await writeFile(
    join(item.directory, 'artifacts', 'orphan', 'new.txt'),
    'Новый файл после просмотра',
  );
  await expect(item.app.reset.reset('tasks', plan.previewToken)).rejects.toThrow('изменился');
  const learningPlan = await item.app.reset.preview('learning');
  await item.app.reset.reset('learning', learningPlan.previewToken);
  expect(await readFile(join(item.directory, 'runs', 'unfinished.tmp'), 'utf8')).toBe(
    'Незавершённый снимок',
  );
  const fresh = await item.app.reset.preview('tasks');
  await item.app.reset.reset('tasks', fresh.previewToken);
  expect(
    Object.keys(await files(item.directory)).some((path) =>
      /\/(runs|output|artifacts|file-backups|indexes|search)\//.test(path),
    ),
  ).toBe(false);
});
