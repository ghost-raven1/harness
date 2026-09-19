import { beforeEach, expect, test, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectStore } from '../src/projects/store.js';
import { ProjectCoordinator } from '../src/projects/coordinator.js';
import type { ProjectRecord } from '../src/projects/types.js';
import type { ProjectJournalEvent } from '../src/projects/validation.js';
import { readJournal } from '../src/sessions/journal.js';
import { cleanup, output, ScriptedProvider } from './helpers.js';
import { projectHarness, draftProject } from './project-helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');
beforeEach(() => {
  vi.mocked(files.open).mockReset().mockImplementation(actual.open);
});

/** Меняет полную JSONL-запись, сохраняя корректный синтаксис и номера событий. */
async function damageLast(path: string, change: (project: ProjectRecord) => void) {
  const events = await readJournal<ProjectJournalEvent>(path);
  change(events.at(-1)!.state);
  await files.writeFile(path, events.map((event) => JSON.stringify(event) + '\n').join(''));
  return files.readFile(path);
}

const damages: Array<{ name: string; change: (record: ProjectRecord) => void }> = [
  {
    name: 'пропавший этап',
    change: (record) => {
      record.stages = {};
    },
  },
  {
    name: 'другой отпечаток этапа',
    change: (record) => {
      record.stages.implement!.definitionHash = 'changed';
    },
  },
  {
    name: 'чужая ссылка запуска этапа',
    change: (record) => {
      record.stages.implement!.runId = 'other-run';
      record.stages.implement!.sessionId = 'other-session';
    },
  },
  {
    name: 'повтор запуска в таблице',
    change: (record) => {
      record.runIds = ['same-run', 'same-run'];
    },
  },
  {
    name: 'этап намерения вне плана',
    change: (record) => {
      record.intent = {
        kind: 'stage',
        stageId: 'missing',
        attempt: 0,
        requestKey: 'intent',
        message: 'Задача',
      };
    },
  },
  {
    name: 'проверки без закреплённых команд',
    change: (record) => {
      record.intent = { kind: 'checks', attempt: 0, requestKey: 'intent', message: 'Проверка' };
    },
  },
  {
    name: 'сообщение чужому запуску',
    change: (record) => {
      record.messages = [
        { requestKey: 'message', runId: 'other', stageId: 'implement', message: 'Уточнение' },
      ];
    },
  },
];

test.each(damages)(
  'повреждённая завершённая запись: $name включает диагностику без исполнения',
  async ({ change }) => {
    const provider = new ScriptedProvider(() => output('Нельзя запускать'));
    const app = await projectHarness(provider);
    const project = await draftProject(app);
    const before = await app.projectStore.get(project.projectId);
    await app.projects.close();
    const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
    const damaged = await damageLast(path, change);
    const restored = new ProjectStore(app.sessions.directory);
    await restored.initialize();
    expect(restored.recoveryError).toBeTruthy();
    const coordinator = new ProjectCoordinator({ ...app.coordinator.options, store: restored });
    cleanup(() => coordinator.close());
    await coordinator.initialize();
    await expect(
      restored.save(before, before.revision, 'project.test', 'Не записывать'),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(provider.requests).toEqual([]);
    expect(await files.readFile(path)).toEqual(damaged);
  },
);

test('обычный читатель не обрезает хвост, а владелец восстанавливает только незавершённые байты', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  await app.projects.close();
  const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
  const original = await files.readFile(path);
  await files.appendFile(path, '{"schemaVersion":1,"seq":');
  const damaged = await files.readFile(path);
  await expect(readJournal(path)).rejects.toThrow('JOURNAL_TORN_TAIL');
  const reader = new ProjectStore(app.sessions.directory);
  await reader.initialize(false);
  expect(reader.recoveryError).toBeTruthy();
  expect(await files.readFile(path)).toEqual(damaged);
  const owner = new ProjectStore(app.sessions.directory);
  await owner.initialize(true);
  expect(owner.recoveryError).toBeUndefined();
  expect(await files.readFile(path)).toEqual(original);
  expect((await owner.get(project.projectId)).revision).toBe(project.revision);
  await owner.events(project.projectId, 0, 10);
  await owner.get(project.projectId);
  expect(await files.readFile(path)).toEqual(original);
});

test('восстановление сохраняет ключ создания и не принимает один ключ у двух проектов', async () => {
  const app = await projectHarness();
  const first = await draftProject(app);
  const second = await draftProject(app);
  const record = await app.projectStore.get(first.projectId);
  await app.projects.close();
  const clean = new ProjectStore(app.sessions.directory);
  await clean.initialize(false);
  expect(clean.findRequest(record.requestKey)).toBe(first.projectId);
  const path = join(app.sessions.directory, 'project-records', second.projectId + '.jsonl');
  await damageLast(path, (other) => {
    other.requestKey = record.requestKey;
    other.requestHash = record.requestHash;
  });
  const restored = new ProjectStore(app.sessions.directory);
  await restored.initialize();
  expect(restored.recoveryError).toBeTruthy();
});

test.each(['sync', 'partial'] as const)(
  'отказ %s не продвигает каталог и допускает безопасную повторную запись',
  async (failure) => {
    const app = await projectHarness();
    const project = await draftProject(app);
    const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
    const original = await files.readFile(path);
    const before = await app.projectStore.get(project.projectId);
    const problem = Object.assign(new Error('Проверочный отказ диска'), {
      code: failure === 'partial' ? 'ENOSPC' : 'EIO',
    });
    let injected = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (!injected && String(args[0]) === path && args[1] === 'a') {
        injected = true;
        if (failure === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(problem);
        else
          vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
            await handle.write('{"schemaVersion":1,"seq":');
            throw problem;
          });
      }
      return handle;
    });
    await expect(
      app.projectStore.save(
        { ...before, title: 'Не подтверждено' },
        before.revision,
        'project.test',
        'Отказ',
      ),
    ).rejects.toBe(problem);
    expect(injected).toBe(true);
    expect(await files.readFile(path)).toEqual(original);
    expect(await app.projectStore.get(project.projectId)).toEqual(before);
    const saved = await app.projectStore.save(
      { ...before, title: 'Подтверждено' },
      before.revision,
      'project.test',
      'Повтор',
    );
    expect(saved.revision).toBe(before.revision + 1);
    const restored = new ProjectStore(app.sessions.directory);
    await restored.initialize(false);
    expect(restored.recoveryError).toBeUndefined();
    expect(await restored.get(project.projectId)).toEqual(saved);
  },
);

test('перестроение индекса проекта меняет только производные данные', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
  const index = join(app.sessions.directory, 'project-index', project.projectId + '.json');
  const original = await files.readFile(path);
  await files.writeFile(index, 'Повреждённый индекс');
  expect(await app.projectStore.rebuildIndex()).toMatchObject({
    rebuilt: 1,
    skipped: 0,
    issues: [],
  });
  expect(JSON.parse(await files.readFile(index, 'utf8'))).toHaveProperty('index.schemaVersion', 1);
  expect(await files.readFile(path)).toEqual(original);
  expect((await app.projectStore.get(project.projectId)).revision).toBe(project.revision);
  await files.appendFile(path, '{"unfinished":');
  const damaged = await files.readFile(path);
  expect(await app.projectStore.rebuildIndex()).toMatchObject({
    rebuilt: 0,
    skipped: 1,
    issues: [{ code: 'INDEX_REBUILD_FAILED', kind: 'project' }],
  });
  expect(await files.readFile(path)).toEqual(damaged);
});

test('перестроение не читает внешний проект через подменённый журнал', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  await app.projects.close();
  const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
  const external = join(app.directory, 'outside-project.jsonl');
  const original = await files.readFile(path);
  await files.writeFile(external, original);
  await files.rm(path);
  await files.symlink(external, path);
  const restored = new ProjectStore(app.sessions.directory);
  await restored.initialize(false);
  expect(restored.recoveryError).toBeTruthy();
  expect(await restored.rebuildIndex()).toMatchObject({
    rebuilt: 0,
    skipped: 1,
    issues: [{ code: 'INDEX_REBUILD_FAILED', kind: 'project' }],
  });
  expect(await files.readFile(external)).toEqual(original);
});

test('перестроение сообщает отказ записи индекса и сохраняет подтверждённый журнал', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  const path = join(app.sessions.directory, 'project-records', project.projectId + '.jsonl');
  const index = join(app.sessions.directory, 'project-index', project.projectId + '.json');
  const original = await files.readFile(path);
  await files.rm(index);
  await files.mkdir(index);
  expect(await app.projectStore.rebuildIndex()).toMatchObject({
    rebuilt: 0,
    skipped: 1,
    issues: [{ code: 'INDEX_REBUILD_FAILED', kind: 'project' }],
  });
  expect(await files.readFile(path)).toEqual(original);
  expect((await app.projectStore.get(project.projectId)).revision).toBe(project.revision);
});
