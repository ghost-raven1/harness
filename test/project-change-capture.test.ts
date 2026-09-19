import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { resolveCaptureSettings } from '../src/configuration/project-capture.js';
import { configSchema } from '../src/configuration/schema.js';
import type { WorkspaceCaptureOptions } from '../src/projects/change-capture.js';
import { fixtureConfig, temporary } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
afterEach(() => vi.mocked(fs.open).mockReset().mockImplementation(actual.open));

/** Каждая проверка использует отдельное состояние, не затрагивая пользовательские задачи. */
async function fixture() {
  const directory = await temporary();
  const workspace = join(directory, 'workspace');
  await fs.mkdir(workspace);
  const snapshots = new ProjectWorkspace(join(directory, 'state'));
  const options: WorkspaceCaptureOptions = {
    config: fixtureConfig(workspace),
    settings: resolveCaptureSettings(),
  };
  const capture = (id = 'project') => snapshots.capture(id, workspace, [], options);
  return { directory, workspace, snapshots, options, capture };
}

it('получает UTF-8, BOM, CRLF и незавершённую строку из того же чтения, сохраняя старый отпечаток', async () => {
  const app = await fixture();
  const source = join(app.workspace, 'код.ts');
  const text = '\ufeffстрока 😀\r\nбез завершающего перевода';
  await fs.writeFile(source, text);
  const baseline = await app.snapshots.capture('project', app.workspace, []);
  vi.mocked(fs.open).mockClear();
  const snapshot = await app.capture();
  expect(vi.mocked(fs.open).mock.calls.filter(([path]) => path === source)).toHaveLength(1);
  expect(snapshot.digest).toBe(baseline.digest);
  const manifest = await app.snapshots.content.readContentManifest('project', snapshot.contentRef!);
  expect(manifest.snapshotRef).toBe(snapshot.ref);
  expect(manifest.snapshotDigest).toBe(snapshot.digest);
  expect(manifest.entries[0]!.content?.digest).toBe(
    createHash('sha256').update(text).digest('hex'),
  );
  await fs.writeFile(source, 'другой файл');
  expect(await app.snapshots.content.readContent('project', snapshot.contentRef!, 'код.ts')).toBe(
    text,
  );
  expect(await app.snapshots.readEntries('project', snapshot.ref)).toEqual(
    await app.snapshots.readEntries('project', baseline.ref),
  );
});

it('отличает бинарные, невалидные UTF-8 и слишком большие файлы, не сохраняя их байты', async () => {
  const app = await fixture();
  app.options.settings.fileBytes = 16;
  await fs.writeFile(join(app.workspace, 'binary.dat'), Buffer.from([65, 0, 66]));
  await fs.writeFile(join(app.workspace, 'encoding.txt'), Buffer.from([0xc3, 0x28]));
  await fs.writeFile(join(app.workspace, 'large.txt'), 'x'.repeat(17));
  await fs.writeFile(join(app.workspace, 'empty.txt'), '');
  const snapshot = await app.capture();
  const manifest = await app.snapshots.content.readContentManifest('project', snapshot.contentRef!);
  expect(
    Object.fromEntries(
      manifest.entries.map((entry) => [entry.path, entry.unavailableReason ?? 'saved']),
    ),
  ).toEqual({
    'binary.dat': 'binary',
    'encoding.txt': 'encoding',
    'large.txt': 'too-large',
    'empty.txt': 'saved',
  });
  expect(
    await app.snapshots.content.readContent('project', snapshot.contentRef!, 'empty.txt'),
  ).toBe('');
  expect((await app.snapshots.content.usage()).totalBytes).toBe(0);
});

it('не копирует deny/ask и закрытые права роли; исключённые файлы не попадают даже в метаданные', async () => {
  const app = await fixture();
  for (const name of [
    'allow.ts',
    'ask.ts',
    'deny.ts',
    'role.ts',
    '.env',
    'private.key',
    'secret.ts',
  ])
    await fs.writeFile(join(app.workspace, name), name);
  app.options.config.policy.rules.push(
    { tool: 'fs.read', args: { path: 'ask.ts' }, decision: 'ask' },
    { tool: 'fs.read', args: { path: 'deny.ts' }, decision: 'deny' },
  );
  app.options.config.roles.coordinator!.permissions.push({
    tool: 'fs.read',
    args: { path: 'role.ts' },
    decision: 'deny',
  });
  const snapshot = await app.snapshots.capture(
    'project',
    app.workspace,
    ['secret.ts'],
    app.options,
  );
  const manifest = await app.snapshots.content.readContentManifest('project', snapshot.contentRef!);
  expect(manifest.entries.map((entry) => [entry.path, entry.unavailableReason ?? 'saved'])).toEqual(
    [
      ['allow.ts', 'saved'],
      ['ask.ts', 'policy'],
      ['deny.ts', 'policy'],
      ['role.ts', 'policy'],
    ],
  );
  expect((await app.snapshots.content.usage()).totalBytes).toBe(Buffer.byteLength('allow.ts'));
});

it('не следует по ссылкам и показывает изменение типа и исполняемого бита через метаданные', async () => {
  const app = await fixture();
  const source = join(app.workspace, 'source');
  const outside = join(app.directory, 'outside.txt');
  await fs.writeFile(source, 'исходник');
  await fs.writeFile(outside, 'внешний секрет');
  const first = await app.capture();
  await fs.unlink(source);
  await fs.symlink(outside, source, 'file');
  const second = await app.capture();
  const manifest = await app.snapshots.content.readContentManifest('project', second.contentRef!);
  expect(manifest.entries[0]).toMatchObject({
    kind: 'symlink',
    unavailableReason: 'symlink',
    executable: false,
  });
  expect(await app.snapshots.changes('project', first.ref, second.ref)).toEqual([
    { path: 'source', kind: 'modified' },
  ]);
  expect(vi.mocked(fs.open).mock.calls.some(([path]) => path === outside)).toBe(false);
});

it('лимиты учитывают уникальные байты внутри проекта, а между проектами копии независимы', async () => {
  const app = await fixture();
  app.options.settings.projectBytes = 6;
  app.options.settings.totalBytes = 9;
  await fs.writeFile(join(app.workspace, 'a.txt'), 'aaa');
  await fs.writeFile(join(app.workspace, 'b.txt'), 'aaa');
  await fs.writeFile(join(app.workspace, 'c.txt'), 'ccc');
  await fs.writeFile(join(app.workspace, 'd.txt'), 'ddd');
  const first = await app.capture();
  const firstManifest = await app.snapshots.content.readContentManifest(
    'project',
    first.contentRef!,
  );
  expect(firstManifest.entries.map((entry) => entry.unavailableReason ?? 'saved')).toEqual([
    'saved',
    'saved',
    'saved',
    'project-limit',
  ]);
  await app.capture();
  expect((await app.snapshots.content.usage()).totalBytes).toBe(6);
  const second = await app.capture('other');
  expect(
    (await app.snapshots.content.readContentManifest('other', second.contentRef!)).entries.map(
      (entry) => entry.unavailableReason ?? 'saved',
    ),
  ).toEqual(['saved', 'saved', 'total-limit', 'total-limit']);
  expect(await app.snapshots.content.usage()).toEqual({
    totalBytes: 9,
    projects: { project: 6, other: 3 },
  });
  await fs.rm(join(app.directory, 'state/project-content/project'), { recursive: true });
  app.snapshots.content.forget('project');
  expect((await app.snapshots.content.usage()).totalBytes).toBe(3);
  expect(await app.snapshots.content.readContent('other', second.contentRef!, 'a.txt')).toBe('aaa');
});

it('перезапуск восстанавливает учёт лимита с диска без загрузки содержимого', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'one'), '12345');
  app.options.settings.projectBytes = 5;
  await app.capture();
  const reopened = new ProjectWorkspace(join(app.directory, 'state'));
  await fs.writeFile(join(app.workspace, 'one'), '54321');
  const next = await reopened.capture('project', app.workspace, [], app.options);
  expect(
    (await reopened.content.readContentManifest('project', next.contentRef!)).entries[0]!
      .unavailableReason,
  ).toBe('project-limit');
  expect((await reopened.content.usage()).totalBytes).toBe(5);
});

it('старые снимки не получают копии; выключенный режим сохраняет явную причину', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'one'), 'код');
  const old = await app.snapshots.capture('legacy', app.workspace, []);
  expect(old.contentRef).toBeUndefined();
  await expect(fs.stat(join(app.directory, 'state/project-content'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  app.options.settings.enabled = false;
  const next = await app.capture();
  expect(
    (await app.snapshots.content.readContentManifest('project', next.contentRef!)).entries[0]!
      .unavailableReason,
  ).toBe('disabled');
  expect(configSchema.parse(app.options.config).projects).toBeUndefined();
  expect(() =>
    configSchema.parse({
      ...app.options.config,
      projects: { capture: { fileBytes: 4 * 1024 * 1024 + 1 } },
    }),
  ).toThrow();
});

it('управляемые копии внутри рабочей папки не меняют прежний отпечаток', async () => {
  const workspace = await temporary();
  const directory = join(workspace, 'custom-state');
  await fs.mkdir(directory);
  await fs.writeFile(join(workspace, 'source.ts'), 'текст');
  const snapshots = new ProjectWorkspace(directory);
  const before = await snapshots.capture('project', workspace, []);
  const captured = await snapshots.capture('project', workspace, [], {
    config: fixtureConfig(workspace),
    settings: resolveCaptureSettings(),
  });
  expect(captured.digest).toBe(before.digest);
  expect((await snapshots.inspect('project', workspace, [])).digest).toBe(before.digest);
  expect(
    (await snapshots.content.readContentManifest('project', captured.contentRef!)).entries.map(
      (entry) => entry.path,
    ),
  ).toEqual(['source.ts']);
});

it('не публикует контрольную точку, если исходный файл изменился после чтения', async () => {
  const app = await fixture();
  const source = join(app.workspace, 'source');
  await fs.writeFile(source, 'начало');
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (args[0] === source) {
      const stat = file.stat.bind(file);
      let calls = 0;
      file.stat = (async (...options: Parameters<typeof stat>) => {
        const value = await stat(...options);
        if (++calls === 1) await fs.writeFile(source, 'подмена');
        return value;
      }) as typeof file.stat;
    }
    return file;
  });
  await expect(app.capture()).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  expect(await fs.readdir(join(app.directory, 'state/project-content/project/manifests'))).toEqual(
    [],
  );
  expect(await fs.readdir(join(app.directory, 'state/project-artifacts/project'))).toEqual([]);
});

it.each(['ENOSPC', 'EIO'])(
  'отказ записи %s не выдаёт частичную копию за сохранённую',
  async (code) => {
    const app = await fixture();
    await fs.writeFile(join(app.workspace, 'source'), 'текст');
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      if (String(args[0]).includes(join('project-content', 'project', 'blobs'))) {
        file.sync = async () => {
          throw Object.assign(new Error('disk failure'), { code });
        };
      }
      return file;
    });
    await expect(app.capture()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(
      await fs.readdir(join(app.directory, 'state/project-content/project/manifests')),
    ).toEqual([]);
    expect(await fs.readdir(join(app.directory, 'state/project-content/project/blobs'))).toEqual(
      [],
    );
  },
);

it('отвергает чужие, отсутствующие и повреждённые объекты, а не заменяет их текущими исходниками', async () => {
  const app = await fixture();
  await fs.writeFile(join(app.workspace, 'source'), 'верный текст');
  const snapshot = await app.capture();
  await expect(
    app.snapshots.content.readContentManifest('other', snapshot.contentRef!),
  ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  const manifest = await app.snapshots.content.readContentManifest('project', snapshot.contentRef!);
  const path = join(
    app.directory,
    'state/project-content/project/blobs',
    manifest.entries[0]!.digest,
  );
  await fs.writeFile(path, 'чужой текст');
  await expect(
    app.snapshots.content.readContent('project', snapshot.contentRef!, 'source'),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  await fs.unlink(path);
  await expect(
    app.snapshots.content.readContent('project', snapshot.contentRef!, 'source'),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  await fs.writeFile(join(app.directory, 'state', snapshot.contentRef!), '{}');
  await expect(
    app.snapshots.content.readContentManifest('project', snapshot.contentRef!),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});

it('не записывает копии через подменённый внутренний каталог', async () => {
  const app = await fixture();
  const outside = join(app.directory, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(join(app.directory, 'state'));
  await fs.symlink(
    outside,
    join(app.directory, 'state/project-content'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await fs.writeFile(join(app.workspace, 'source'), 'текст');
  await expect(app.capture()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(await fs.readdir(outside)).toEqual([]);
});

it('копии не включают токены известных настроек и содержимое нестандартной папки состояния', async () => {
  const workspace = await temporary();
  const directory = join(workspace, 'custom-state');
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, 'saved-run.json'), '{"text":"private state"}');
  await fs.writeFile(join(workspace, '.npmrc'), '//registry/:_authToken=private');
  await fs.writeFile(join(workspace, '.ENV.LOCAL'), 'TOKEN=private');
  await fs.writeFile(join(workspace, 'source.ts'), 'export const answer = 42;');
  const snapshots = new ProjectWorkspace(directory);
  const old = await snapshots.capture('project', workspace, []);
  const next = await snapshots.capture('project', workspace, [], {
    settings: resolveCaptureSettings(),
    config: fixtureConfig(workspace),
  });
  expect(next.digest).toBe(old.digest);
  const manifest = await snapshots.content.readContentManifest('project', next.contentRef!);
  expect(manifest.entries.filter((entry) => entry.content).map((entry) => entry.path)).toEqual([
    'source.ts',
  ]);
  expect(
    manifest.entries.find((entry) => entry.path === 'custom-state/saved-run.json')!
      .unavailableReason,
  ).toBe('policy');
});

it('не копирует известные SSH и AWS ключи, сохраняя прежние метаданные отпечатка', async () => {
  const app = await fixture();
  for (const directory of ['.ssh', '.aws']) await fs.mkdir(join(app.workspace, directory));
  const paths = [
    '.ssh/id_dsa',
    '.ssh/id_ecdsa',
    '.ssh/id_ecdsa_sk',
    '.ssh/id_ed25519_sk',
    '.aws/credentials',
  ];
  for (const path of paths)
    await fs.writeFile(join(app.workspace, path), `фиктивный секрет для теста: ${path}`);
  await fs.writeFile(join(app.workspace, 'source.ts'), 'export const answer = 42;');
  await fs.writeFile(join(app.workspace, '.ssh/id_ecdsa.pub'), 'фиктивный публичный ключ');
  const old = await app.snapshots.capture('project', app.workspace, []);
  const next = await app.capture();
  expect(next.digest).toBe(old.digest);
  expect(await app.snapshots.readEntries('project', next.ref)).toEqual(
    await app.snapshots.readEntries('project', old.ref),
  );
  const manifest = await app.snapshots.content.readContentManifest('project', next.contentRef!);
  for (const path of paths) {
    const entry = manifest.entries.find((item) => item.path === path);
    expect.soft(entry).toMatchObject({ unavailableReason: 'policy' });
    expect.soft(entry?.content).toBeUndefined();
  }
  expect(manifest.entries.filter((entry) => entry.content).map((entry) => entry.path)).toEqual([
    '.ssh/id_ecdsa.pub',
    'source.ts',
  ]);
});
