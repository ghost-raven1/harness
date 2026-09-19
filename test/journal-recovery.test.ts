import { beforeEach, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { join, relative } from 'node:path';
import { appendJournal, appendJournalBatch, readJournal } from '../src/sessions/journal.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { FileLearningStore } from '../src/learning/store.js';
import { call, harness, output, ScriptedProvider, temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');
beforeEach(() => {
  vi.mocked(files.open).mockReset().mockImplementation(actual.open);
});

it.each(['partial', 'sync', 'close'] as const)(
  'отказ %s не оставляет неподтверждённое событие перед следующей записью',
  async (failure) => {
    const path = join(await temporary(), 'journal.jsonl');
    const first = { seq: 1, text: 'Подтверждено' };
    await appendJournal(path, first);
    const before = await files.readFile(path);
    const problem = Object.assign(new Error('Проверочный отказ записи'), { code: 'EIO' });
    vi.mocked(files.open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args);
      if (failure === 'partial')
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
          await file.write('{"seq":2,"text":"Оборвано');
          throw problem;
        });
      if (failure === 'sync') vi.spyOn(file, 'sync').mockRejectedValueOnce(problem);
      if (failure === 'close') {
        const close = file.close.bind(file);
        vi.spyOn(file, 'close').mockImplementationOnce(async () => {
          await close();
          throw problem;
        });
      }
      return file;
    });
    await expect(appendJournal(path, { seq: 2, text: 'Не подтверждено' })).rejects.toBe(problem);
    expect(await files.readFile(path)).toEqual(before);

    const next = { seq: 2, text: 'Повтор после устранения сбоя' };
    await appendJournal(path, next);
    expect(await readJournal(path)).toEqual([first, next]);
  },
);

it('откат пачки удаляет и полную строку, и частичный хвост неподтверждённой записи', async () => {
  const path = join(await temporary(), 'output.jsonl');
  await appendJournal(path, { seq: 1 });
  vi.mocked(files.open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
      await file.write('{"seq":2}\n{"seq":3');
      throw new Error('Обрыв пачки');
    });
    return file;
  });
  await expect(appendJournalBatch(path, [{ seq: 2 }, { seq: 3 }])).rejects.toThrow('Обрыв пачки');
  await appendJournalBatch(path, [
    { seq: 2, retry: true },
    { seq: 3, retry: true },
  ]);
  expect(await readJournal(path)).toEqual([
    { seq: 1 },
    { seq: 2, retry: true },
    { seq: 3, retry: true },
  ]);
});

it.each(['truncate', 'sync'] as const)(
  'неподтверждённый откат %s блокирует дальнейшую запись только повреждённого журнала',
  async (failure) => {
    const root = await temporary();
    const path = join(root, 'blocked.jsonl');
    await appendJournal(path, { seq: 1 });
    vi.mocked(files.open)
      .mockImplementationOnce(async (...args) => {
        const file = await actual.open(...args);
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async () => {
          await file.write('{"seq":2');
          throw new Error('Обрыв записи');
        });
        return file;
      })
      .mockImplementationOnce(async (...args) => {
        const file = await actual.open(...args);
        vi.spyOn(file, failure).mockRejectedValueOnce(new Error('Отказ отката'));
        return file;
      });
    await expect(appendJournal(path, { seq: 2 })).rejects.toThrow('Перезапустите');
    // Чтение для диагностики не делает прежний кэш пригодным для дальнейшей записи.
    expect(await readJournal(path)).toEqual([{ seq: 1 }]);
    const before = await files.readFile(path);
    await expect(appendJournal(relative(process.cwd(), path), { seq: 2 })).rejects.toThrow(
      'требует восстановления',
    );
    expect(await files.readFile(path)).toEqual(before);
    const other = join(root, 'other.jsonl');
    await appendJournal(other, { seq: 1 });
    expect(await readJournal(other)).toEqual([{ seq: 1 }]);
  },
);

it('ошибка fsync не рассинхронизирует номера и состояние журнала обучения', async () => {
  const root = await temporary();
  const store = new FileLearningStore(root);
  await store.initialize();
  await store.update((state) => {
    state.paused = true;
  });
  vi.mocked(files.open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    vi.spyOn(file, 'sync').mockRejectedValueOnce(new Error('Отказ fsync'));
    return file;
  });
  await expect(
    store.update((state) => {
      state.paused = false;
    }),
  ).rejects.toThrow('Отказ fsync');
  expect(store.read().paused).toBe(true);
  await store.update((state) => {
    state.ignoredRunIds = ['проверенная задача'];
  });
  const recovered = new FileLearningStore(root);
  await recovered.initialize();
  expect(recovered.read()).toEqual(store.read());
});

it('частичная запись результата инструмента сохраняет неизвестный исход и не повторяет эффект', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [call('write', 'fs.write', { path: 'result.txt', content: 'Записано' })])
      : output('Результат проверен'),
  );
  const app = await harness(provider);
  let interrupted = false;
  vi.mocked(files.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (args[1] === 'a' && String(args[0]).endsWith('.jsonl')) {
      const write = file.writeFile.bind(file);
      vi.spyOn(file, 'writeFile').mockImplementation(async (data, options) => {
        if (!interrupted && String(data).includes('"type":"tool.succeeded"')) {
          interrupted = true;
          await file.write(String(data).slice(0, 80));
          throw new Error('Диск отказал при записи результата');
        }
        return write(data, options);
      });
    }
    return file;
  });
  const { runId } = await app.runtime.start({
    message: 'Запиши файл один раз',
    workspace: app.workspace,
    requestKey: 'partial-tool-journal',
  });
  await app.runtime.wait(runId);
  expect(interrupted).toBe(true);
  const paused = app.sessions.get(runId);
  expect(paused.status).toBe('paused');
  expect(Object.values(paused.invocations)[0]?.status).toBe('unknown');
  const recovered = new FileSessionStore(app.sessions.directory);
  await recovered.initialize();
  expect(recovered.get(runId)).toEqual(paused);
  await expect(app.runtime.resume(runId)).rejects.toThrow('Resolve unknown');
  await files.writeFile(join(app.workspace, 'result.txt'), 'Проверено человеком');
  await app.runtime.resolveInvocation(
    runId,
    Object.keys(paused.invocations)[0]!,
    'Запись подтверждена человеком',
    true,
  );
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('completed');
  expect(app.sessions.get(runId).fileChanges).toHaveLength(1);
  expect(await files.readFile(join(app.workspace, 'result.txt'), 'utf8')).toBe(
    'Проверено человеком',
  );
});
