import { expect, it, vi, afterEach } from 'vitest';
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newAgent } from '../src/agents/service.js';
import { HistoryCache } from '../src/sessions/cache.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { readJournal } from '../src/sessions/journal.js';
import * as validation from '../src/sessions/validation.js';
import * as journalIndex from '../src/sessions/journal-index.js';
import { verifyHistory } from '../src/diagnostics/history-verification.js';
import { writePurgeRecord, type PurgeRecord } from '../src/sessions/purge-records.js';
import type { JournalEvent, RunRecord } from '../src/sessions/types.js';
import { hash, id } from '../src/shared/primitives.js';
import { fixtureConfig, temporary } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Создаёт завершённый запуск без новых необязательных полей состояния. */
function runRecord(directory: string): RunRecord {
  const config = fixtureConfig(directory);
  const agent = newAgent('coordinator', 'Историческая задача');
  agent.status = 'completed';
  return {
    schemaVersion: 1,
    id: id(),
    sessionId: id(),
    requestKey: id(),
    requestHash: hash(id()),
    workspace: directory,
    profile: 'test',
    config: { value: config, hash: hash(config) },
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
    result: 'Результат',
  };
}

/** Записывает fixture напрямую: тесты управляют границей подтверждённых строк. */
async function writeRun(directory: string, run: RunRecord, count = 1): Promise<string> {
  await mkdir(join(directory, 'runs'), { recursive: true });
  const path = join(directory, 'runs', run.id + '.jsonl');
  const rows: string[] = [];
  for (let seq = 1; seq <= count; seq++) {
    const event: JournalEvent = {
      seq,
      at: run.createdAt,
      type: 'fixture',
      payload: {},
      state: run,
    };
    rows.push(JSON.stringify(event));
  }
  await writeFile(path, rows.join('\n') + '\n');
  return path;
}

/** Формирует подтверждённое намерение удаления всей беседы. */
function tombstone(run: RunRecord): PurgeRecord {
  return {
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
}

it('LRU соблюдает предел, обновляет давность чтения и не удерживает слишком крупную запись', () => {
  const cache = new HistoryCache<string>(30);
  cache.set('a', 'aaaa');
  cache.set('b', 'bbbb');
  expect(cache.get('a')).toBe('aaaa');
  cache.set('c', 'cccc');
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe('aaaa');
  expect(cache.stats()).toMatchObject({ entries: 2, bytes: 24, maximumBytes: 30 });
  cache.set('large', 'x'.repeat(100));
  expect(cache.get('large')).toBeUndefined();
  expect(cache.stats().entries).toBe(2);
  cache.delete('a');
  expect(cache.stats().bytes).toBe(12);
  expect(new HistoryCache().maximumBytes).toBe(64 * 1024 * 1024);
});

it('поиск находит окончание полного ответа, а кэш запроса учитывает скрытые задачи', async () => {
  const directory = await temporary();
  const hidden = runRecord(directory);
  hidden.deletedAt = new Date().toISOString();
  hidden.result = 'x'.repeat(300000) + ' УникальныйОтвет';
  const visible = runRecord(directory);
  visible.result = 'Видимый УникальныйОтвет';
  await writeRun(directory, hidden);
  await writeRun(directory, visible);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  expect(await store.search('уникальныйответ')).toEqual(new Set([visible.id]));
  expect(await store.search('уникальныйответ', true)).toEqual(new Set([visible.id, hidden.id]));
  const matches = await store.search('уникальныйответ', true);
  matches.clear();
  expect(await store.search('уникальныйответ', true)).toEqual(new Set([visible.id, hidden.id]));
  await store.mutate(visible.id, 'result.changed', {}, (run) => {
    run.result = 'Другой результат';
  });
  expect(await store.search('уникальныйответ')).toEqual(new Set());
});

it('повторный запуск использует готовый индекс без перестроения и перезаписи', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  await writeRun(directory, run);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  const path = join(directory, 'indexes', 'runs', run.id + '.json');
  const before = await readFile(path);
  const modifiedAt = (await stat(path)).mtimeMs;
  const build = vi.spyOn(journalIndex, 'buildIndex');
  const save = vi.spyOn(journalIndex, 'saveIndex');
  const reopened = new FileSessionStore(directory);
  await reopened.initialize({ recover: false });
  expect(reopened.recoveryError).toBeUndefined();
  expect((await reopened.load(run.id)).result).toBe(run.result);
  expect(build).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(await readFile(path)).toEqual(before);
  expect((await stat(path)).mtimeMs).toBe(modifiedAt);
});

it('checksum индекса учитывает исключение undefined-полей при сохранении JSON', async () => {
  const directory = await temporary();
  const source = join(directory, 'source.jsonl');
  const path = join(directory, 'index.json');
  await writeFile(source, '{"seq":1}\n');
  const { index } = await journalIndex.buildIndex(source, (value) => value);
  const data = {
    parentRunId: undefined,
    deletedAt: undefined,
    nested: { missing: undefined },
    list: [undefined, 1],
  };
  await journalIndex.saveIndex(path, index, data, true);
  const restored = await journalIndex.readIndex(path, source, (value) => value);
  expect(restored?.index).toEqual(index);
  expect(restored?.data).toEqual({ nested: {}, list: [null, 1] });
});

it.each(['missing', 'corrupt', 'stale'] as const)(
  'восстанавливает %s индекс без изменения журналов',
  async (failure) => {
    const directory = await temporary();
    const run = runRecord(directory);
    const source = await writeRun(directory, run, 260);
    const store = new FileSessionStore(directory);
    await store.initialize({ recover: false });
    const indexPath = join(directory, 'indexes', 'runs', run.id + '.json');
    if (failure === 'missing') await rm(indexPath);
    if (failure === 'corrupt') await writeFile(indexPath, 'CORRUPT INDEX');
    if (failure === 'stale') {
      run.result = 'Новый подтверждённый ответ';
      await appendFile(
        source,
        JSON.stringify({ seq: 261, at: run.createdAt, type: 'updated', payload: {}, state: run }) +
          '\n',
      );
    }
    const before = await readFile(source);
    const reopened = new FileSessionStore(directory);
    await reopened.initialize({ recover: false });
    expect(reopened.recoveryError).toBeUndefined();
    expect((await reopened.load(run.id)).result).toBe(run.result);
    expect((await reopened.history(run.id, 128, 2)).map((row) => row.seq)).toEqual([129, 130]);
    expect(await readFile(source)).toEqual(before);
    const saved = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(saved.index.positions.map((position: { seq: number }) => position.seq)).toEqual([
      1, 129, 257,
    ]);
    expect((await reopened.rebuildIndex()).issues).toEqual([]);
    expect(await readFile(source)).toEqual(before);
  },
);

it.each(['last-offset', 'first-offset'] as const)(
  'отвергает неверный %s даже при согласованном checksum',
  async (failure) => {
    const directory = await temporary();
    const run = runRecord(directory);
    const source = await writeRun(directory, run, 3);
    const store = new FileSessionStore(directory);
    await store.initialize({ recover: false });
    const path = join(directory, 'indexes', 'runs', run.id + '.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    if (failure === 'last-offset') stored.index.lastOffset = stored.index.size + 1;
    else stored.index.positions[0].offset = 1;
    stored.checksum = hash({ index: stored.index, data: stored.data });
    await writeFile(path, JSON.stringify(stored));
    const before = await readFile(source);
    const reopened = new FileSessionStore(directory);
    await reopened.initialize({ recover: false });
    expect(reopened.recoveryError).toBeUndefined();
    expect((await reopened.history(run.id, 0, 3)).map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(await readFile(source)).toEqual(before);
  },
);

it('страница длинного журнала начинает проверку у ближайшего разреженного смещения', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  await writeRun(directory, run, 1000);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  const validate = vi.spyOn(validation, 'validateJournalEvent');
  const page = await store.history(run.id, 900, 5);
  expect(page.map((row) => row.seq)).toEqual([901, 902, 903, 904, 905]);
  expect(validate.mock.calls.length).toBeGreaterThan(0);
  expect(validate.mock.calls.length).toBeLessThanOrEqual(128 + 5);
});

it('страница крупных событий ограничена объёмом и следующий курсор не теряет запись', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  run.result = 'x'.repeat(3 * 1024 * 1024);
  await writeRun(directory, run, 3);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  const first = await store.history(run.id, 0, 100);
  expect(first.map((row) => row.seq)).toEqual([1, 2]);
  const next = await store.history(run.id, first.at(-1)!.seq, 100);
  expect(next.map((row) => row.seq)).toEqual([3]);
});

it('повреждение завершённой строки включает просмотр, не используя устаревший JSON-снимок', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  const source = await writeRun(directory, run);
  const initial = new FileSessionStore(directory);
  await initial.initialize({ recover: false });
  await writeFile(join(directory, 'runs', run.id + '.json'), JSON.stringify(run));
  await appendFile(source, 'CORRUPT COMPLETED RECORD\n');
  const before = await readFile(source);
  const reopened = new FileSessionStore(directory);
  await reopened.initialize();
  expect(reopened.recoveryError).toBeTruthy();
  expect(reopened.catalog(true)).toEqual([]);
  await expect(reopened.create(runRecord(directory))).rejects.toThrow();
  await expect(reopened.load(run.id)).rejects.toThrow();
  expect(await readFile(source)).toEqual(before);
});

it('явное перестроение сообщает об отказе сохранения индекса, сохраняя исходный журнал', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  const source = await writeRun(directory, run);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  const path = join(directory, 'indexes', 'runs', run.id + '.json');
  await rm(path);
  await mkdir(path);
  const before = await readFile(source);
  const report = await store.rebuildIndex();
  expect(report).toMatchObject({
    rebuilt: 0,
    skipped: 1,
    issues: [{ code: 'INDEX_REBUILD_FAILED', kind: 'run' }],
  });
  expect(await readFile(source)).toEqual(before);
  expect((await store.load(run.id)).result).toBe(run.result);
});

it('отказ производного индекса не отменяет подтверждённое изменение задачи', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  const source = await writeRun(directory, run);
  const store = new FileSessionStore(directory);
  await store.initialize({ recover: false });
  const path = join(directory, 'indexes', 'runs', run.id + '.json');
  await rm(path);
  await mkdir(path);
  await expect(
    store.mutate(run.id, 'result.confirmed', {}, (state) => {
      state.result = 'Сохранено несмотря на отказ индекса';
    }),
  ).resolves.toMatchObject({ result: 'Сохранено несмотря на отказ индекса' });
  expect((await readJournal<JournalEvent>(source)).at(-1)?.state.result).toBe(
    'Сохранено несмотря на отказ индекса',
  );
  const reopened = new FileSessionStore(directory);
  await reopened.initialize({ recover: false });
  expect(reopened.recoveryError).toBeUndefined();
  expect((await reopened.load(run.id)).result).toBe('Сохранено несмотря на отказ индекса');
});

it('обычное чтение и обслуживание не обрезают хвост, владелец при запуске восстанавливает его', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  const source = await writeRun(directory, run);
  const confirmed = await readFile(source);
  await appendFile(source, '{"seq":2');
  const torn = await readFile(source);
  await expect(readJournal(source)).rejects.toMatchObject({ code: 'JOURNAL_TORN_TAIL' });
  expect(await readFile(source)).toEqual(torn);
  const maintenance = new FileSessionStore(directory);
  await maintenance.initialize({ recover: false });
  expect(maintenance.recoveryError).toBeTruthy();
  expect(await readFile(source)).toEqual(torn);
  const owner = new FileSessionStore(directory);
  await owner.initialize();
  expect(owner.recoveryError).toBeUndefined();
  expect(await owner.load(run.id)).toEqual(run);
  expect(await readFile(source)).toEqual(confirmed);
});

it('исторические необязательные настройки, разрешения и версия опыта остаются исходными', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  delete (run.config.value.limits as Partial<typeof run.config.value.limits>).modelConcurrency;
  run.config.hash = hash(run.config.value);
  run.learningVersion = 'historical-release';
  run.approvals.approval = {
    id: 'approval',
    runId: run.id,
    agentId: run.rootAgentId,
    callId: 'write',
    binding: 'historical-binding',
    tool: 'fs.write',
    args: { path: 'result.txt' },
    reason: 'Подтверждено человеком',
    status: 'consumed',
  };
  run.invocations.write = {
    id: 'write',
    agentId: run.rootAgentId,
    role: 'coordinator',
    call: { id: 'write', name: 'fs.write', arguments: '{"path":"result.txt"}' },
    effect: 'write',
    status: 'succeeded',
    result: 'Сохранено',
    startedAt: run.createdAt,
    finishedAt: run.createdAt,
  };
  const source = await writeRun(directory, run);
  const before = await readFile(source);
  const store = new FileSessionStore(directory);
  await store.initialize();
  expect(await store.load(run.id)).toEqual(run);
  expect(await readFile(source)).toEqual(before);
});

it('полное удаление убирает производные файлы, временные копии и кэш поиска', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  run.result = 'DELETE_PRIVATE_TEXT';
  await writeRun(directory, run);
  const store = new FileSessionStore(directory);
  await store.initialize();
  await store.output.append(run.id, [
    {
      at: run.createdAt,
      requestId: id(),
      agentId: run.rootAgentId,
      role: 'coordinator',
      type: 'text',
      text: run.result,
    },
  ]);
  expect(await store.search('DELETE_PRIVATE_TEXT')).toEqual(new Set([run.id]));
  for (const [folder, extension] of [
    ['runs', 'jsonl'],
    ['output', 'jsonl'],
    ['indexes/runs', 'json'],
    ['indexes/output', 'json'],
    ['search', 'txt'],
  ] as const) {
    await writeFile(join(directory, folder, `${run.id}.${extension}.${id()}.tmp`), run.result);
  }
  const record = tombstone(run);
  await store.recordPurge(record);
  await store.purgeFiles(record);
  expect(store.catalog(true)).toEqual([]);
  expect(await store.search('DELETE_PRIVATE_TEXT', true)).toEqual(new Set());
  expect(store.cacheStats().entries).toBe(0);
  for (const folder of ['runs', 'output', 'indexes/runs', 'indexes/output', 'search'])
    expect((await readdir(join(directory, folder))).some((name) => name.startsWith(run.id))).toBe(
      false,
    );
  expect(() => store.assertRequestAllowed(run.requestKey)).toThrow('удалена');
});

it('маркер удаления имеет приоритет над повреждёнными остатками задачи и вывода', async () => {
  const directory = await temporary();
  const run = runRecord(directory);
  const source = await writeRun(directory, run);
  await writePurgeRecord(directory, tombstone(run));
  await appendFile(source, 'CORRUPT REMOVED RECORD\n');
  await mkdir(join(directory, 'output'));
  const output = join(directory, 'output', run.id + '.jsonl');
  await writeFile(output, '{"seq":1');
  const before = await readFile(source);
  const outputBefore = await readFile(output);
  const store = new FileSessionStore(directory);
  await store.initialize();
  expect(store.recoveryError).toBeUndefined();
  expect(store.catalog(true)).toEqual([]);
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: true,
    counts: { journals: 0, runs: 0, outputs: 0 },
  });
  expect((await store.rebuildIndex()).issues).toEqual([]);
  expect(await readFile(source)).toEqual(before);
  expect(await readFile(output)).toEqual(outputBefore);
  expect(() => store.assertRequestAllowed(run.requestKey)).toThrow('удалена');
});
