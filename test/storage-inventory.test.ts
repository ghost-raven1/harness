import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { taskStorageInventory } from '../src/application/data-reset-records.js';
import { hash } from '../src/shared/primitives.js';
import { temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
afterEach(() => {
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fs.readdir).mockReset().mockImplementation(actual.readdir);
});

/** Временная копия участвует в обходе наравне с устойчивыми файлами каскада. */
async function fixture() {
  const directory = await temporary();
  const folder = join(directory, 'project-content', 'project', 'manifests');
  await fs.mkdir(folder, { recursive: true });
  const pending = join(folder, 'snapshot.json.pending.tmp');
  await fs.writeFile(pending, '{"files":[]}');
  return { directory, folder, pending };
}

it('атомарное переименование во время обхода повторяет весь состав без потери опубликованного файла', async () => {
  const item = await fixture();
  const published = join(item.folder, 'snapshot.json');
  const orphan = join(item.directory, 'runs', 'orphan.tmp');
  await fs.mkdir(join(item.directory, 'runs'));
  await fs.writeFile(orphan, 'незавершённая запись');
  let renamed = false;
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if (String(args[0]) === item.pending && !renamed) {
      renamed = true;
      await fs.rename(item.pending, published);
    }
    return actual.lstat(...args);
  });
  const inventory = await taskStorageInventory(item.directory);
  expect(renamed).toBe(true);
  expect(inventory.map((entry) => entry.path)).toEqual([
    'project-content/project/manifests/snapshot.json',
    'runs/orphan.tmp',
  ]);
  expect(hash(inventory)).toBe(hash(await taskStorageInventory(item.directory)));
  await fs.writeFile(published, '{"files":["new.ts"]}');
  expect(hash(inventory)).not.toBe(hash(await taskStorageInventory(item.directory)));
});

it('переименование вложенного каталога не скрывает его содержимое из состава удаления', async () => {
  const item = await fixture();
  const moved = item.folder + '-ready';
  let renamed = false;
  vi.mocked(fs.readdir).mockImplementation(async (...args) => {
    if (String(args[0]) === item.folder && !renamed) {
      renamed = true;
      await fs.rename(item.folder, moved);
    }
    return actual.readdir(...args);
  });
  expect((await taskStorageInventory(item.directory)).map((entry) => entry.path)).toEqual([
    'project-content/project/manifests-ready/snapshot.json.pending.tmp',
  ]);
  expect(renamed).toBe(true);
});

it('непрерывное изменение состава ограничивает повторы и не выдаёт неполный предпросмотр', async () => {
  const item = await fixture();
  let attempts = 0;
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if (String(args[0]) === item.pending) {
      attempts++;
      throw Object.assign(new Error('Файл переименован'), { code: 'ENOENT' });
    }
    return actual.lstat(...args);
  });
  await expect(taskStorageInventory(item.directory)).rejects.toMatchObject({ code: 'TASK_BUSY' });
  expect(attempts).toBe(3);
});

it('ошибка доступа к файлу не превращается в пропуск или повтор обхода', async () => {
  const item = await fixture();
  const denied = Object.assign(new Error('Нет доступа'), { code: 'EACCES' });
  let attempts = 0;
  vi.mocked(fs.lstat).mockImplementation(async (...args) => {
    if (String(args[0]) === item.pending) {
      attempts++;
      throw denied;
    }
    return actual.lstat(...args);
  });
  await expect(taskStorageInventory(item.directory)).rejects.toBe(denied);
  expect(attempts).toBe(1);
});
