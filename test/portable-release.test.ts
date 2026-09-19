import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { expect, test } from 'vitest';
import { temporary } from './helpers.js';

const files = await import(pathToFileURL(resolve('scripts/portable-files.mjs')).href);
const content = await import(pathToFileURL(resolve('scripts/portable-content.mjs')).href);
const check = await import(pathToFileURL(resolve('scripts/portable-check.mjs')).href);
const execute = promisify(execFile);

test('нативная матрица не выдаёт непроверенную архитектуру за готовую поставку', () => {
  for (const [platform, arch, name] of [
    ['linux', 'x64', 'linux'],
    ['win32', 'x64', 'windows'],
    ['darwin', 'arm64', 'macos'],
    ['darwin', 'x64', 'macos'],
  ])
    expect(content.portableTarget(platform, arch)).toEqual({
      nodePlatform: platform,
      arch,
      platform: name,
    });
  expect(() => content.portableTarget('linux', 'arm64')).toThrow('не поддерживается');
  expect(() => content.portableTarget('win32', 'ia32')).toThrow('не поддерживается');
});

test('потоковый ZIP сохраняет содержимое, Unicode, манифест и исполняемые права', async () => {
  const root = await temporary();
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'Запустить.sh'), '#!/bin/sh\nprintf "готово"\n', { mode: 0o755 });
  await writeFile(join(source, 'payload.bin'), Buffer.alloc(2 * 1024 * 1024, 147));
  const manifest = {
    schemaVersion: 1,
    version: '0.6.1',
    platform: 'macos',
    arch: 'arm64',
    files: await files.portableInventory(source),
  };
  await writeFile(join(source, 'portable-manifest.json'), JSON.stringify(manifest));
  const archive = join(root, 'fixture.zip');
  await files.writePortableZip(source, 'fixture', await files.portableInventory(source), archive);
  const bytes = await readFile(archive);
  let offset = bytes.readUInt32LE(bytes.length - 6);
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const length = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    if (name === 'fixture/Запустить.sh' && process.platform !== 'win32')
      expect((bytes.readUInt32LE(offset + 38) >>> 16) & 0o777).toBe(0o755);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  const target = join(root, 'Распаковано с пробелами');
  expect(await files.extractPortableZip(archive, 'fixture', target)).toBe(3);
  await files.verifyPortableFiles(target, manifest);
  expect(await readFile(join(target, 'payload.bin'))).toEqual(
    await readFile(join(source, 'payload.bin')),
  );
  if (process.platform !== 'win32')
    expect((await stat(join(target, 'Запустить.sh'))).mode & 0o777).toBe(0o755);
  await writeFile(join(target, 'payload.bin'), 'повреждение');
  await expect(files.verifyPortableFiles(target, manifest)).rejects.toThrow('Повреждённый');
});

test.each([
  '../outside',
  '/absolute',
  'C:/outside',
  'file/../outside',
  'file\\outside',
  'file.',
  'CON',
  'nul.txt',
])('ZIP отвергает опасный путь %s до записи', async (name) => {
  const root = await temporary();
  const archive = join(root, 'bad.zip');
  const entries = Object.create(null);
  entries['fixture/' + name] = Buffer.from('bad');
  await writeFile(archive, zipSync(entries));
  await expect(files.extractPortableZip(archive, 'fixture', join(root, 'target'))).rejects.toThrow(
    'путь',
  );
});

test('ZIP не допускает имена, совпадающие на Windows, и лишние файлы вне манифеста', async () => {
  const root = await temporary();
  const archive = join(root, 'bad.zip');
  await writeFile(
    archive,
    zipSync({ 'fixture/Name': Buffer.from('one'), 'fixture/name': Buffer.from('two') }),
  );
  await expect(files.extractPortableZip(archive, 'fixture', join(root, 'target'))).rejects.toThrow(
    'Повторный',
  );
});

test('копирование исключает npm bin и отвергает ссылки вне staging', async () => {
  const root = await temporary();
  const source = join(root, 'source');
  await mkdir(join(source, '.bin'), { recursive: true });
  await writeFile(join(source, '.bin', 'npm'), 'запрещено');
  await writeFile(join(source, 'module.js'), 'export {};');
  await content.copyPortableTree(source, join(root, 'target'), true);
  expect(
    (await files.portableInventory(join(root, 'target'))).map(
      (file: { path: string }) => file.path,
    ),
  ).toEqual(['module.js']);
  await symlink(
    join(root, 'target'),
    join(source, 'outside'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(content.copyPortableTree(source, join(root, 'rejected'), true)).rejects.toThrow(
    'Ссылка',
  );
});

test('офлайн-проверка блокирует TCP/fetch и не передаёт пользовательские ключи', async () => {
  const root = await temporary();
  const guard = join(root, 'защита #100% с пробелами.mjs');
  await copyFile(resolve('scripts/portable-offline.mjs'), guard);
  const env = check.portableEnvironment(root, guard);
  const preload = JSON.parse(env.NODE_OPTIONS.slice('--import '.length));
  expect(new URL(preload).protocol).toBe('file:');
  expect(preload).toContain('%23100%25');
  expect(env.PATH).toBe('');
  expect(env.CODEX_HOME).toBe(join(root, 'codex'));
  expect(env).not.toHaveProperty('OPENAI_API_KEY');
  const result = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import assert from 'node:assert/strict'; import net from 'node:net';",
        "assert.throws(()=>net.connect({host:'127.0.0.1',port:1}),/NETWORK_DISABLED/);",
        "await assert.rejects(fetch('https://example.invalid'),/NETWORK_DISABLED/);",
        "console.log('offline');",
      ].join(''),
    ],
    { env },
  );
  expect(result.stdout.trim()).toBe('offline');
});

test.skipIf(process.platform === 'win32')(
  'launcher работает с пустым PATH и передаёт аргументы буквально',
  async () => {
    const root = join(await temporary(), 'Папка [с пробелами]');
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'dist/interfaces'), { recursive: true });
    await writeFile(join(root, 'runtime/node'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n', {
      mode: 0o755,
    });
    await content.writeLaunchers(root, '0.6.1', content.portableTarget('darwin', 'arm64'));
    const literal = 'пробелы $(не-команда) `текст` ; $HOME';
    const result = await execute('/bin/sh', [join(root, 'Запустить Harness.command'), literal], {
      cwd: '/',
      env: { PATH: '' },
    });
    expect(result.stdout.trim().split('\n')).toEqual([
      root,
      join(root, 'dist/interfaces/cli.js'),
      literal,
    ]);
  },
);

test.skipIf(process.platform !== 'win32')(
  'Windows launcher сохраняет Unicode и argv без cmd /c escaping',
  async () => {
    const root = join(await temporary(), 'Папка [с пробелами]');
    await mkdir(join(root, 'dist/interfaces'), { recursive: true });
    await symlink(dirname(process.execPath), join(root, 'runtime'), 'junction');
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(root, 'dist/interfaces/cli.js'),
      'console.log(JSON.stringify(process.argv.slice(2)));',
    );
    await content.writeLaunchers(root, '0.6.1', content.portableTarget('win32', 'x64'));
    const args = ['--state', 'папка [данные] с пробелами', '--json', 'mcp-config'];
    const command = check.windowsLauncher(join(root, 'Запустить Harness.cmd'), args);
    const result = await execute(command.executable, command.args, {
      env: { ...process.env, PATH: '', ...command.env },
      timeout: 10000,
      windowsHide: true,
    });
    expect(JSON.parse(result.stdout.trim())).toEqual(args);
  },
);
