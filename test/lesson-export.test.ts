import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dispatch } from '../src/interfaces/routes.js';
import type { Application } from '../src/interfaces/application.js';
import type { LearningCandidate } from '../src/learning/types.js';
import { temporary } from './helpers.js';

async function fixture() {
  const directory = await temporary();
  const candidate: LearningCandidate = {
    id: randomUUID(),
    sourceRunId: randomUUID(),
    workspace: directory,
    role: 'coordinator',
    profile: 'fixture',
    title: 'Проверка экспорта',
    lesson: 'Проверяйте результат сохранения файла.',
    appliesWhen: 'При экспорте данных.',
    evidenceIds: [],
    status: 'candidate',
    fingerprint: 'fixture',
  };
  const app = {
    directory,
    sessions: { assertWritable() {} },
    scheduler: { schedule: async (_effect: string, work: () => Promise<unknown>) => work() },
    learning: {
      store: {
        read: () => ({
          activeVersion: 'baseline',
          candidates: { [candidate.id]: candidate },
          evidence: {},
          reports: {},
          releases: { baseline: { candidateIds: [] } },
        }),
      },
    },
  } as unknown as Application;
  return {
    directory,
    path: join(directory, 'exports', 'Урок Harness ' + candidate.id + '.md'),
    save: () => dispatch(app, 'learning.export', { id: candidate.id }),
  };
}

it('повторный экспорт узнаёт существующий Markdown и сохраняет правки человека', async () => {
  const item = await fixture();
  await expect(item.save()).resolves.toEqual({ path: item.path });
  await writeFile(item.path, 'Мои заметки');
  await expect(item.save()).resolves.toEqual({ path: item.path, exists: true });
  expect(await readFile(item.path, 'utf8')).toBe('Мои заметки');
});

it('файл вместо exports не считается существующим Markdown и не изменяется', async () => {
  const item = await fixture();
  const blocked = join(item.directory, 'exports');
  await writeFile(blocked, 'Проверочная помеха');
  await expect(item.save()).rejects.toThrow('Экспорт не записан');
  expect(await readFile(blocked, 'utf8')).toBe('Проверочная помеха');
});

it('папка на месте Markdown не выдаётся за сохранённый файл', async () => {
  const item = await fixture();
  await mkdir(item.path, { recursive: true });
  await expect(item.save()).rejects.toThrow('Экспорт не записан');
});
