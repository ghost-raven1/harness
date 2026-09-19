import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { WorkspaceLeases } from '../src/projects/workspace-leases.js';
import { temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
afterEach(() => vi.mocked(fs.open).mockReset().mockImplementation(actual.open));

/** Состояние Harness отделено от исходных файлов даже в тестах без Git. */
async function fixture() {
  const root = await temporary();
  const directory = join(root, 'state');
  const workspace = join(root, 'исходники с пробелами');
  await fs.mkdir(workspace);
  return { root, directory, workspace, snapshots: new ProjectWorkspace(directory) };
}

it('управляемый экспорт не меняет отпечаток даже при нестандартном state внутри рабочей папки', async () => {
  const workspace = await temporary();
  const state = join(workspace, 'custom-state');
  await fs.mkdir(state);
  await fs.writeFile(join(workspace, 'index.ts'), 'export const answer = 42;');
  const snapshots = new ProjectWorkspace(state);
  const before = await snapshots.capture('nested-state', workspace, []);
  const exports = join(state, 'exports', 'projects', 'nested-state');
  await fs.mkdir(exports, { recursive: true });
  await fs.writeFile(join(exports, 'result.md'), 'Отчёт проверки');
  await fs.writeFile(join(exports, 'receipt.json'), '{}');
  expect((await snapshots.inspect('nested-state', workspace, [])).digest).toBe(before.digest);
  // Пользовательский отчёт рядом с исходниками остаётся частью проверяемого проекта.
  await fs.writeFile(join(workspace, 'result.md'), 'Скопировано пользователем');
  expect((await snapshots.inspect('nested-state', workspace, [])).digest).not.toBe(before.digest);
});

it('gitless-снимки устойчивы, сохраняют dirty-файлы и описывают добавления, правки и удаления', async () => {
  const app = await fixture();
  await fs.mkdir(join(app.workspace, 'src'));
  await fs.mkdir(join(app.workspace, '.git'));
  await fs.writeFile(join(app.workspace, '.git/index'), 'локальный индекс не трогать');
  await fs.writeFile(join(app.workspace, 'src/файл.ts'), 'несохранённая в Git работа');
  await fs.writeFile(join(app.workspace, 'removed.ts'), 'старый файл');
  const first = await app.snapshots.capture('project-1', app.workspace, []);
  const repeated = await app.snapshots.capture('project-1', app.workspace, []);
  expect(repeated.digest).toBe(first.digest);
  expect(first.files).toBe(2);
  expect(first.ref).toMatch(/^project-artifacts\/project-1\/[a-f\d-]+\.jsonl$/);
  expect(await app.snapshots.changes('project-1', first.ref, repeated.ref)).toEqual([]);
  await fs.writeFile(join(app.workspace, 'src/файл.ts'), 'новая работа');
  await fs.unlink(join(app.workspace, 'removed.ts'));
  await fs.writeFile(join(app.workspace, 'added.ts'), 'добавлен');
  const changed = await app.snapshots.capture('project-1', app.workspace, []);
  expect(changed.digest).not.toBe(first.digest);
  expect(await app.snapshots.changes('project-1', first.ref, changed.ref)).toEqual([
    { path: 'added.ts', kind: 'added' },
    { path: 'removed.ts', kind: 'deleted' },
    { path: 'src/файл.ts', kind: 'modified' },
  ]);
  expect(await fs.readFile(join(app.workspace, 'src/файл.ts'), 'utf8')).toBe('новая работа');
  expect(await fs.readFile(join(app.workspace, '.git/index'), 'utf8')).toBe(
    'локальный индекс не трогать',
  );
  const manifest = await fs.readFile(join(app.directory, first.ref), 'utf8');
  expect(manifest).not.toContain(app.workspace);
  expect(manifest).not.toContain('несохранённая в Git работа');
});

it('исключает секреты, генерируемые каталоги и запрещённые поддеревья', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'source.ts'), 'код');
  await fs.writeFile(join(app.workspace, '.env'), 'SECRET');
  await fs.writeFile(join(app.workspace, 'certificate.pem'), 'PRIVATE KEY');
  const folders = [
    '.git',
    'node_modules',
    '.harness',
    '.tools',
    'dist',
    'build',
    'coverage',
    '.cache',
    '.next',
    'private',
    'secrets',
  ];
  for (const folder of folders) {
    await fs.mkdir(join(app.workspace, folder));
    await fs.writeFile(join(app.workspace, folder, 'data.txt'), 'исключено');
  }
  const before = await app.snapshots.capture('excluded', app.workspace, ['private', 'secrets/**']);
  expect(before.files).toBe(1);
  await fs.writeFile(join(app.workspace, 'private/data.txt'), 'изменённый секрет');
  await fs.writeFile(join(app.workspace, 'dist/another.js'), 'сборка');
  const after = await app.snapshots.capture('excluded', app.workspace, ['private', 'secrets/**']);
  expect(after.digest).toBe(before.digest);
});

it('символические ссылки сравниваются по цели без чтения внешних файлов и обхода каталогов', async () => {
  const app = await fixture();
  const outside = join(app.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(join(outside, 'secret.txt'), 'внешний секрет');
  await fs.symlink(
    outside,
    join(app.workspace, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const first = await app.snapshots.capture('links', app.workspace, []);
  expect(first.files).toBe(1);
  await fs.writeFile(join(outside, 'secret.txt'), 'изменённый внешний секрет');
  const unchanged = await app.snapshots.capture('links', app.workspace, []);
  expect(unchanged.digest).toBe(first.digest);
  const other = join(app.root, 'other');
  await fs.mkdir(other);
  await fs.unlink(join(app.workspace, 'linked'));
  await fs.symlink(
    other,
    join(app.workspace, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const moved = await app.snapshots.capture('links', app.workspace, []);
  expect(await app.snapshots.changes('links', first.ref, moved.ref)).toEqual([
    { path: 'linked', kind: 'modified' },
  ]);
});

it('хеширует большой файл потоком и не сохраняет его содержимое в манифест', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'large.bin'), Buffer.alloc(8 * 1024 * 1024, 0x61));
  const first = await app.snapshots.capture('stream', app.workspace, []);
  expect((await fs.stat(join(app.directory, first.ref))).size).toBeLessThan(1024);
  const file = await fs.open(join(app.workspace, 'large.bin'), 'r+');
  await file.write(Buffer.from('b'), 0, 1, 7 * 1024 * 1024);
  await file.close();
  const changed = await app.snapshots.capture('stream', app.workspace, []);
  expect(changed.digest).not.toBe(first.digest);
});

it.each(['during-read', 'after-read'])(
  'не публикует смешанный снимок при изменении файла: %s',
  async (mode) => {
    const app = await fixture();
    const first = join(app.workspace, 'a.ts');
    const second = join(app.workspace, 'b.ts');
    await fs.writeFile(first, 'до изменения');
    await fs.writeFile(second, 'следующий файл');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      if (mode === 'after-read' && args[0] === second)
        await fs.writeFile(first, 'изменено после чтения');
      if (mode === 'during-read' && args[0] === first) {
        const stat = file.stat.bind(file);
        let calls = 0;
        file.stat = (async (...options: Parameters<typeof stat>) => {
          const value = await stat(...options);
          if (++calls === 1) await fs.writeFile(first, 'изменено перед чтением');
          return value;
        }) as typeof file.stat;
      }
      return file;
    });
    await expect(app.snapshots.capture('race', app.workspace, [])).rejects.toMatchObject({
      code: 'PROJECT_CHANGED',
    });
    expect(await fs.readdir(join(app.directory, 'project-artifacts/race'))).toEqual([]);
  },
);

it('повторное получение папки замечает внешние изменения после release', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'source.ts'), 'до паузы');
  const leases = new WorkspaceLeases(() => []);
  leases.acquire('resume', app.workspace);
  const before = await app.snapshots.capture('resume', app.workspace, []);
  leases.release('resume');
  await fs.writeFile(join(app.workspace, 'source.ts'), 'правка пользователя на паузе');
  leases.acquire('resume', app.workspace);
  const after = await app.snapshots.capture('resume', app.workspace, []);
  expect(after.digest).not.toBe(before.digest);
  expect(await app.snapshots.changes('resume', before.ref, after.ref)).toEqual([
    { path: 'source.ts', kind: 'modified' },
  ]);
  leases.release('resume');
});

it('отвергает чужие ссылки и повреждённую контрольную сумму снимка', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'source.ts'), 'код');
  const first = await app.snapshots.capture('owner', app.workspace, []);
  await expect(app.snapshots.changes('other', first.ref, first.ref)).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  await expect(app.snapshots.capture('../outside', app.workspace, [])).rejects.toMatchObject({
    code: 'INVALID_REQUEST',
  });
  const path = join(app.directory, first.ref);
  await fs.writeFile(path, (await fs.readFile(path, 'utf8')).replace('source.ts', 'edited.ts'));
  await expect(app.snapshots.changes('owner', first.ref, first.ref)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
});

it('не записывает артефакты через подменённую ссылкой папку состояния', async () => {
  const app = await fixture();
  const outside = join(app.root, 'untouched');
  await fs.mkdir(outside);
  await fs.mkdir(app.directory);
  await fs.symlink(
    outside,
    join(app.directory, 'project-artifacts'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(app.snapshots.capture('owner', app.workspace, [])).rejects.toThrow(
    'заменена ссылкой',
  );
  expect(await fs.readdir(outside)).toEqual([]);
});

it('подмена исходного файла ссылкой перед открытием не читает внешнее содержимое', async () => {
  const app = await fixture();
  const source = join(app.workspace, 'source.ts');
  const outside = join(app.root, 'secret.txt');
  await fs.writeFile(source, 'код');
  await fs.writeFile(outside, 'внешний секрет');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (args[0] === source) {
      await fs.unlink(source);
      await fs.symlink(outside, source, 'file');
    }
    const file = await actual.open(...args);
    if (args[0] === source)
      file.createReadStream = () => {
        throw new Error('Внешний файл не должен читаться');
      };
    return file;
  });
  const result = await app.snapshots.capture('replace', app.workspace, []).catch((error) => error);
  expect(result.code).toBe('PROJECT_CHANGED');
  expect(result.cause.message).not.toBe('Внешний файл не должен читаться');
  expect(await fs.readdir(join(app.directory, 'project-artifacts/replace'))).toEqual([]);
  expect(await fs.readFile(outside, 'utf8')).toBe('внешний секрет');
});

it('отвергает слишком большой манифест до его загрузки', async () => {
  const app = await fixture();
  const snapshot = await app.snapshots.capture('bounded', app.workspace, []);
  const file = await fs.open(join(app.directory, snapshot.ref), 'r+');
  await file.truncate(17 * 1024 * 1024);
  await file.close();
  await expect(app.snapshots.changes('bounded', snapshot.ref, snapshot.ref)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
});
