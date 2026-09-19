import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { zipSync } from 'fflate';
import { withProjectLock } from './project-lock.mjs';

const rootFiles = [
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.nvmrc',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.prettierignore',
  '.prettierrc.json',
  'tsconfig.json',
  'tsconfig.build.json',
  'vitest.config.ts',
  'Dockerfile.test',
  'README.md',
  'Начните здесь.txt',
  'start.sh',
  'Запустить Harness.command',
  'Запустить Harness.cmd',
];
const scripts = [
  'bootstrap.mjs',
  'build.mjs',
  'build-state.mjs',
  'project-lock.mjs',
  'preparation-command.mjs',
  'install-runtime.mjs',
  'check-engines.mjs',
  'benchmark-storage.mjs',
  'benchmark-projects.mjs',
  'benchmark-project-diff.mjs',
  'start-windows.ps1',
  'release-pack.mjs',
  'release-smoke.mjs',
  'portable-pack.mjs',
  'portable-check.mjs',
  'portable-content.mjs',
  'portable-files.mjs',
  'portable-offline.mjs',
  'portable-probe.mjs',
  'portable-windows-diagnostic.mjs',
  'playtest-cloud.mjs',
  'playtest-codex.mjs',
  'playtest-opencode.mjs',
];
const trees = [
  ['src', ['.ts']],
  ['test', ['.ts', '.mjs']],
  ['config', ['.json', '.md']],
  ['examples', ['.json']],
  ['docs', ['.md']],
  ['scripts/fixtures', ['.mjs', '.py']],
];
const executable = new Set(['start.sh', 'Запустить Harness.command']);
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'releases',
  'coverage',
  'tmp',
  'temp',
  '__pycache__',
]);
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = (name) => (executable.has(name) ? 0o755 : 0o644);

/** Поставка читает только разрешённые файлы; ссылки и специальные файлы не разыменовываются. */
async function releaseFiles(root) {
  const files = [...rootFiles, ...scripts.map((name) => 'scripts/' + name)];
  async function walk(relative, extensions) {
    const directory = join(root, relative);
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Каталог поставки должен быть обычной папкой: ' + relative);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) continue;
      const path = relative + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Ссылка запрещена в поставке: ' + path);
      if (entry.isDirectory()) await walk(path, extensions);
      else if (extensions.includes(extname(entry.name))) files.push(path);
    }
  }
  for (const [directory, extensions] of trees) await walk(directory, extensions);
  for (const entry of await readdir(join(root, 'scripts'), { withFileTypes: true })) {
    if (!entry.name.startsWith('.') && entry.name.endsWith('.py'))
      files.push('scripts/' + entry.name);
  }
  const result = [];
  for (const name of files.sort(order)) {
    // Проверяется каждый компонент явно перечисленных путей, в том числе scripts/.
    const parts = name.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/');
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink() || (index === parts.length ? !info.isFile() : !info.isDirectory()))
        throw new Error('Необычный файл запрещён в поставке: ' + path);
    }
    result.push([name, await readFile(join(root, name))]);
  }
  return result;
}

function validateManifest(files) {
  const contents = new Map(files);
  const manifest = JSON.parse(contents.get('package.json'));
  const lock = JSON.parse(contents.get('package-lock.json'));
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(manifest.version))
    throw new Error('Версия package.json не подходит для имени архива.');
  if (manifest.name !== lock.name || manifest.version !== lock.version)
    throw new Error('Версии package.json и package-lock.json не совпадают.');
  for (const field of [
    'name',
    'version',
    'engines',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    if (!isDeepStrictEqual(manifest[field], lock.packages?.['']?.[field]))
      throw new Error('package-lock.json не согласован с package.json: ' + field);
  }
  return manifest;
}

/** ZIP имеет постоянные даты и права; содержимое исходников автор проверяет перед передачей. */
export async function packRelease(root) {
  return withProjectLock(root, async (lease) => {
    const files = await releaseFiles(root);
    const manifest = validateManifest(files);
    const directory = 'harness-' + manifest.version + '-source';
    const release = {
      schemaVersion: 1,
      name: manifest.name,
      version: manifest.version,
      files: files.map(([path, bytes]) => ({ path, sha256: sha256(bytes), mode: mode(path) })),
    };
    files.push(['release-manifest.json', Buffer.from(JSON.stringify(release, null, 2) + '\n')]);
    const entries = Object.create(null);
    for (const [name, bytes] of files) {
      entries[directory + '/' + name] = [
        bytes,
        {
          // ZIP хранит местное календарное время, поэтому фиксируем его без UTC-смещения.
          mtime: new Date(1980, 0, 1, 0, 0, 0),
          os: 3,
          attrs: ((0o100000 | mode(name)) << 16) >>> 0,
        },
      ];
    }
    const archive = zipSync(entries, { level: 9 });
    const checksum = sha256(archive);
    const destination = join(root, 'releases');
    await mkdir(destination, { recursive: true });
    if (!(await lstat(destination)).isDirectory())
      throw new Error('Каталог releases должен быть обычной папкой.');
    const filename = directory + '.zip';
    const temporary = join(destination, '.' + randomUUID());
    try {
      await writeFile(temporary, archive, { flag: 'wx', mode: 0o644 });
      await writeFile(temporary + '.sha256', checksum + '  ' + filename + '\n', {
        flag: 'wx',
        mode: 0o644,
      });
      await lease.assertOwned();
      await rename(temporary, join(destination, filename));
      await rename(temporary + '.sha256', join(destination, filename + '.sha256'));
    } finally {
      await rm(temporary, { force: true });
      await rm(temporary + '.sha256', { force: true });
    }
    return { archive: join(destination, filename), sha256: checksum, files: files.length };
  });
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    console.log(JSON.stringify(await packRelease(root), null, 2));
  } catch (error) {
    console.error('Не удалось собрать поставку: ' + error.message);
    process.exitCode = 1;
  }
}
