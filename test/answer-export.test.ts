import { beforeEach, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { join } from 'node:path';
import { saveAnswer } from '../src/interfaces/guided/answer-export.js';
import { temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');
beforeEach(() => {
  vi.mocked(files.open).mockReset().mockImplementation(actual.open);
  vi.mocked(files.link).mockReset().mockImplementation(actual.link);
});

async function answer() {
  return { workspace: await temporary(), runId: 'test-run', result: 'Целый ответ\nВторая строка' };
}

it('повторное и конкурентное сохранение одинакового ответа оставляет один целый файл', async () => {
  const status = await answer();
  const [first, second] = await Promise.all([saveAnswer(status), saveAnswer(status)]);
  expect(second).toBe(first);
  const before = await files.stat(first);
  expect(await saveAnswer(status)).toBe(first);
  expect((await files.stat(first)).mtimeMs).toBe(before.mtimeMs);
  expect(await files.readFile(first, 'utf8')).toBe(status.result + '\n');
  expect(await files.readdir(status.workspace)).toEqual(['Ответ Harness test-run.md']);
});

it('другой текст не объявляется сохранённым и не изменяет существующий файл', async () => {
  const status = await answer();
  const path = join(status.workspace, 'Ответ Harness test-run.md');
  await files.writeFile(path, 'Собственные заметки');
  await expect(saveAnswer(status)).rejects.toMatchObject({
    code: 'EEXIST',
    message: expect.stringContaining('содержит другой текст'),
  });
  expect(await files.readFile(path, 'utf8')).toBe('Собственные заметки');
  expect(await files.readdir(status.workspace)).toEqual(['Ответ Harness test-run.md']);
});

it.each(['symlink', 'directory'] as const)(
  'не принимает %s за ранее сохранённый ответ',
  async (kind) => {
    const status = await answer();
    const path = join(status.workspace, 'Ответ Harness test-run.md');
    const outside = join(await temporary(), 'Пользовательский файл.txt');
    await files.writeFile(outside, status.result + '\n');
    if (kind === 'symlink') await files.symlink(outside, path);
    else await files.mkdir(path);
    await expect(saveAnswer(status)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await files.readFile(outside, 'utf8')).toBe(status.result + '\n');
    expect(await files.readdir(status.workspace)).toEqual(['Ответ Harness test-run.md']);
  },
);

it('сбой после частичной записи удаляет временный файл; повтор сохраняет весь ответ', async () => {
  const status = await answer();
  vi.mocked(files.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await handle.write('Только начало');
      throw Object.assign(new Error('Принудительный обрыв записи'), { code: 'EFBIG' });
    });
    return handle;
  });
  await expect(saveAnswer(status)).rejects.toMatchObject({
    code: 'EFBIG',
    message: expect.stringContaining('слишком большой'),
  });
  expect(await files.readdir(status.workspace)).toEqual([]);
  const path = await saveAnswer(status);
  expect(await files.readFile(path, 'utf8')).toBe(status.result + '\n');
});

it('имя готового ответа отсутствует, пока содержимое записано лишь частично', async () => {
  const status = await answer();
  let release!: () => void;
  const pause = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const partial = new Promise<void>((resolve) => (started = resolve));
  vi.mocked(files.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
      await handle.write(status.result.slice(0, 3));
      started();
      await pause;
      await handle.write(status.result.slice(3) + '\n');
    });
    return handle;
  });
  const saving = saveAnswer(status);
  await partial;
  expect((await files.readdir(status.workspace)).every((name) => name.endsWith('.tmp'))).toBe(true);
  release();
  const path = await saving;
  expect(await files.readFile(path, 'utf8')).toBe(status.result + '\n');
  expect(await files.readdir(status.workspace)).toEqual(['Ответ Harness test-run.md']);
});

it('отказ публикации не оставляет частичный файл и сообщает понятную причину', async () => {
  const status = await answer();
  vi.mocked(files.link).mockRejectedValueOnce(
    Object.assign(new Error('Запись запрещена'), { code: 'EACCES' }),
  );
  await expect(saveAnswer(status)).rejects.toMatchObject({
    code: 'EACCES',
    message: expect.stringContaining('Нет доступа для записи'),
  });
  expect(await files.readdir(status.workspace)).toEqual([]);
});
