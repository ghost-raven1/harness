import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSessionStore } from '../src/sessions/store.js';
import * as journal from '../src/sessions/journal.js';
import { newAgent } from '../src/agents/service.js';
import { hash, id } from '../src/shared/primitives.js';
import type { RunRecord } from '../src/sessions/types.js';
import type { PurgeRecord } from '../src/sessions/purge-records.js';
import { fixtureConfig, temporary } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Вытесняет только выбранный снимок, чтобы воспроизвести обычное асинхронное чтение архива. */
class ArchiveProbe extends FileSessionStore {
  private beforeRepair?: () => Promise<void>;
  discardCached(runId: string): void {
    this.historical.delete(runId);
    this.runs.delete(runId);
  }

  /** Останавливает поиск после загрузки снимка, перед входом в очередь изменения файлов. */
  pauseNextRepair() {
    const reached = checkpoint();
    const resume = checkpoint();
    this.beforeRepair = async () => {
      reached.resolve();
      await resume.promise;
    };
    return { reached: reached.promise, resume: resume.resolve };
  }

  protected override async repairSearch(run: RunRecord): Promise<void> {
    const before = this.beforeRepair;
    this.beforeRepair = undefined;
    await before?.();
    await super.repairSearch(run);
  }
}

/** Даёт тесту явные точки остановки без задержек, зависящих от скорости файловой системы. */
function checkpoint() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Создаёт завершённый запуск с единственным писателем и маленьким снимком. */
async function fixture() {
  const directory = await temporary();
  const value = fixtureConfig(directory);
  const agent = newAgent('coordinator', 'Проверка поколения архива');
  agent.status = 'completed';
  const run: RunRecord = {
    schemaVersion: 1,
    id: id(),
    sessionId: id(),
    requestKey: id(),
    requestHash: hash(id()),
    workspace: directory,
    profile: 'test',
    config: { value, hash: hash(value) },
    learningVersion: 'baseline',
    status: 'completed',
    rootAgentId: agent.id,
    agents: { [agent.id]: agent },
    invocations: {},
    approvals: {},
    artifacts: [],
    turns: 1,
    handoffs: 0,
    usage: { input: 1, output: 1 },
    createdAt: new Date().toISOString(),
    result: 'Старый ответ',
  };
  const store = new ArchiveProbe(directory);
  await store.initialize();
  await store.create(run);
  const marker: PurgeRecord = {
    schemaVersion: 1,
    sessionId: run.sessionId,
    runIds: [run.id],
    requestDigests: [hash(run.requestKey)],
    candidateIds: [],
    evidenceIds: [],
    reportIds: [],
    previewToken: hash('preview'),
    complete: false,
  };
  return { directory, store, run, marker };
}

/** Удерживает первую уже прочитанную строку, позволяя другому клиенту изменить состояние. */
function pauseRead(path: string) {
  const reached = checkpoint();
  const resume = checkpoint();
  const original = journal.scanJournal;
  let intercepted = false;
  vi.spyOn(journal, 'scanJournal').mockImplementation(async function* paused<T = unknown>(
    file: string,
    start = 0,
  ) {
    for await (const row of original<T>(file, start)) {
      if (!intercepted && file === path) {
        intercepted = true;
        reached.resolve();
        await resume.promise;
      }
      yield row;
    }
  });
  return { reached: reached.promise, resume: resume.resolve };
}

it('запоздавшее чтение не подменяет более новое подтверждённое изменение задачи', async () => {
  const { directory, store, run } = await fixture();
  store.discardCached(run.id);
  const barrier = pauseRead(join(directory, 'runs', run.id + '.jsonl'));
  const pending = store.load(run.id);
  try {
    await barrier.reached;
    await store.mutate(run.id, 'result.changed', {}, (state) => {
      state.result = 'Новый ответ';
    });
    barrier.resume();
    expect((await pending).result).toBe('Новый ответ');
    expect(store.get(run.id).result).toBe('Новый ответ');
    expect(store.catalog()[0]?.seq).toBe(2);
  } finally {
    barrier.resume();
    await pending.catch(() => undefined);
  }
});

it('запоздавшее чтение не возвращает удалённую задачу в кэш или каталог', async () => {
  const { directory, store, run, marker } = await fixture();
  store.discardCached(run.id);
  const barrier = pauseRead(join(directory, 'runs', run.id + '.jsonl'));
  const pending = store.load(run.id);
  try {
    await barrier.reached;
    await store.recordPurge(marker);
    await store.purgeFiles(marker);
    barrier.resume();
    await expect(pending).rejects.toThrow();
    expect(store.catalog(true)).toEqual([]);
    expect(store.cacheStats().entries).toBe(0);
    expect(() => store.get(run.id)).toThrow();
    await expect(store.load(run.id)).rejects.toThrow();
    await expect(readFile(join(directory, 'runs', run.id + '.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    barrier.resume();
    await pending.catch(() => undefined);
  }
});

it('поиск не создаёт заново удалённые данные при запоздавшем чтении снимка', async () => {
  const { directory, store, run, marker } = await fixture();
  await rm(join(directory, 'search', run.id + '.txt'));
  store.discardCached(run.id);
  const barrier = pauseRead(join(directory, 'runs', run.id + '.jsonl'));
  const pending = store.search('Старый ответ');
  try {
    await barrier.reached;
    await store.recordPurge(marker);
    await store.purgeFiles(marker);
    barrier.resume();
    await pending.catch(() => undefined);
    expect(await store.search('Старый ответ')).toEqual(new Set());
    await expect(readFile(join(directory, 'search', run.id + '.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    barrier.resume();
    await pending.catch(() => undefined);
  }
});

it('запоздавший ремонт поискового файла не перезаписывает более свежий ответ', async () => {
  const { directory, store, run } = await fixture();
  const path = join(directory, 'search', run.id + '.txt');
  await rm(path);
  const barrier = store.pauseNextRepair();
  const pending = store.search('Старый ответ');
  try {
    await barrier.reached;
    await store.mutate(run.id, 'result.changed', {}, (state) => {
      state.result = 'Новый ответ';
    });
    barrier.resume();
    await pending;
    const content = await readFile(path, 'utf8');
    expect(content).toContain('новый ответ');
    expect(content).not.toContain('старый ответ');
    expect(await store.search('Старый ответ')).toEqual(new Set());
    expect(await store.search('Новый ответ')).toEqual(new Set([run.id]));
  } finally {
    barrier.resume();
    await pending.catch(() => undefined);
  }
});

it('запоздавший ремонт поискового файла не воскрешает данные после подтверждённого удаления', async () => {
  const { directory, store, run, marker } = await fixture();
  const path = join(directory, 'search', run.id + '.txt');
  await rm(path);
  const barrier = store.pauseNextRepair();
  const pending = store.search('Старый ответ');
  try {
    await barrier.reached;
    await store.recordPurge(marker);
    await store.purgeFiles(marker);
    barrier.resume();
    expect(await pending).toEqual(new Set());
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.catalog(true)).toEqual([]);
  } finally {
    barrier.resume();
    await pending.catch(() => undefined);
  }
});
