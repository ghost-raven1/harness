import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = resolve('.');
const version = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  .version as string;
const archiveName = 'harness-' + version + '-source.zip';
const temporary: string[] = [];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rootFiles = [
  'package.json',
  'package-lock.json',
  '.npmrc',
  '.nvmrc',
  '.gitignore',
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

afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Все изменения и архивы находятся в отдельной копии, реальные настройки не читаются. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness release ')));
  temporary.push(root);
  for (const name of [...rootFiles, 'scripts', 'config', 'examples'])
    await cp(join(repository, name), join(root, name), { recursive: true });
  for (const name of ['src', 'test/fixtures', 'docs'])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'src/index.ts'), 'export const release = true;\n');
  await writeFile(join(root, 'test/example.test.ts'), 'export {};\n');
  await writeFile(join(root, 'test/fixtures/mcp.mjs'), 'export {};\n');
  await writeFile(join(root, 'docs/readme.md'), '# Проверка поставки\n');
  await symlink(
    join(repository, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  return root;
}

async function pack(root: string, timezone = 'UTC') {
  const output = await execute(process.execPath, [join(root, 'scripts/release-pack.mjs')], {
    cwd: tmpdir(),
    timeout: 15000,
    env: { ...process.env, TZ: timezone },
  });
  const report = JSON.parse(output.stdout) as { archive: string; sha256: string; files: number };
  return { report, bytes: await readFile(report.archive) };
}

/** Центральный каталог проверяется независимо от распаковщика: CRC, Unix-права и постоянная дата. */
function entries(bytes: Buffer) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const result = [];
  let offset = bytes.readUInt32LE(end + 16);
  while (offset < end) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const length = bytes.readUInt16LE(offset + 28);
    result.push({
      path: bytes.subarray(offset + 46, offset + 46 + length).toString('utf8'),
      crc: bytes.readUInt32LE(offset + 16),
      mode: bytes.readUInt32LE(offset + 38) >>> 16,
      os: bytes[offset + 5],
      time: bytes.readUInt16LE(offset + 12),
      date: bytes.readUInt16LE(offset + 14),
    });
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return result;
}

it('ZIP содержит проверяемые исходники и lockfile; CRC, манифест и права запуска корректны', async () => {
  const root = await fixture();
  const { report, bytes } = await pack(root);
  expect(report.sha256).toBe(hash(bytes));
  expect(await readFile(report.archive + '.sha256', 'utf8')).toBe(
    report.sha256 + '  ' + archiveName + '\n',
  );
  const unpacked = unzipSync(bytes);
  const prefix = 'harness-' + version + '-source/';
  const paths = Object.keys(unpacked).map((path) => path.slice(prefix.length));
  expect(new Set(paths).size).toBe(paths.length);
  expect(paths).toEqual(
    expect.arrayContaining([
      ...rootFiles,
      'scripts/bootstrap.mjs',
      'scripts/preparation-command.mjs',
      'scripts/release-smoke.mjs',
      'src/index.ts',
      'test/example.test.ts',
      'test/fixtures/mcp.mjs',
      'config/prompts/base.md',
      'examples/tools-mcp.json',
      'release-manifest.json',
    ]),
  );
  expect(report.files).toBe(paths.length);
  const manifest = JSON.parse(
    Buffer.from(unpacked[prefix + 'release-manifest.json']!).toString(),
  ) as {
    schemaVersion: number;
    version: string;
    files: Array<{ path: string; sha256: string; mode: number }>;
  };
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.version).toBe(version);
  expect(manifest.files).toHaveLength(paths.length - 1);
  expect(new Set(manifest.files.map((file) => file.path)).size).toBe(manifest.files.length);
  for (const item of entries(bytes)) {
    expect(item.path.startsWith(prefix)).toBe(true);
    expect(item.crc).toBe(crc32(unpacked[item.path]!));
    expect(item.os).toBe(3);
    expect(item.date).toBe(33);
    expect(item.time).toBe(0);
    const name = item.path.slice(prefix.length);
    expect(item.mode).toBe(
      ['start.sh', 'Запустить Harness.command'].includes(name) ? 0o100755 : 0o100644,
    );
    if (name === 'release-manifest.json') continue;
    expect(Buffer.from(unpacked[item.path]!)).toEqual(await readFile(join(root, name)));
    expect(manifest.files.find((file) => file.path === name)).toEqual({
      path: name,
      sha256: hash(unpacked[item.path]!),
      mode: item.mode & 0o777,
    });
  }
});

it('закрытые файлы и синтетические секреты не попадают в ZIP и npm pack', async () => {
  const root = await fixture();
  const marker = 'SYNTHETIC_PRIVATE_RELEASE_MARKER';
  for (const name of [
    '.env.production',
    '.harness/runs/private.json',
    '.tools/keys.json',
    'dist/private.txt',
    'releases/old.txt',
    'src/.private/secret.ts',
    'src/temp/secret.ts',
    'config/.keys.json',
    'src/ignored.txt',
    'docs/private.json',
  ]) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), marker);
  }
  const { bytes } = await pack(root);
  const unpacked = unzipSync(bytes);
  expect(
    Object.keys(unpacked).some((path) => /\/(\.env|\.harness|\.tools|dist|releases)\//.test(path)),
  ).toBe(false);
  expect(Object.values(unpacked).some((value) => Buffer.from(value).includes(marker))).toBe(false);
  const npm = join(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  );
  const output = await execute(
    process.execPath,
    [npm, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', join(root, '.npm-cache')],
    { cwd: root, timeout: 15000 },
  );
  const packed = JSON.parse(output.stdout)[0].files as Array<{ path: string }>;
  expect(
    packed.some(
      ({ path }) =>
        path === '.env.production' ||
        path.startsWith('.harness/') ||
        path.startsWith('.tools/') ||
        path.startsWith('releases/'),
    ),
  ).toBe(false);
});

it('порядок, mtime исходников и часовой пояс не меняют байты ZIP', async () => {
  const root = await fixture();
  const first = await pack(root, 'Pacific/Honolulu');
  await utimes(join(root, 'README.md'), new Date(), new Date());
  const second = await pack(root, 'Asia/Tokyo');
  expect(second.bytes).toEqual(first.bytes);
  expect(second.report.sha256).toBe(first.report.sha256);
});

it.each(['src/linked', 'releases'])(
  'ссылка %s не разыменовывается и не записывает данные снаружи',
  async (name) => {
    const root = await fixture();
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'harness outside ')));
    temporary.push(outside);
    await writeFile(join(outside, 'secret.ts'), 'PRIVATE_TARGET');
    await symlink(outside, join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(pack(root)).rejects.toThrow();
    expect(await readFile(join(outside, 'secret.ts'), 'utf8')).toBe('PRIVATE_TARGET');
    await expect(readFile(join(outside, archiveName))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it.each(['version', 'optionalDependencies'])(
  'несогласованный %s в lockfile не заменяет уже собранную поставку',
  async (field) => {
    const root = await fixture();
    const first = await pack(root);
    const file = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(file, 'utf8'));
    if (field === 'version') lock.packages[''].version = '0.0.0-invalid-fixture';
    else lock.packages[''].optionalDependencies = {};
    await writeFile(file, JSON.stringify(lock));
    await expect(pack(root)).rejects.toThrow('package-lock.json');
    expect(await readFile(first.report.archive)).toEqual(first.bytes);
  },
);
