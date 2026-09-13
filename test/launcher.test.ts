import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const repository = resolve('.');
const release = `node-v24.21.0-${process.platform}-${process.arch}`;

/** Архив и curl локальные; распаковка, установщик и процессы Node выполняются по-настоящему. */
async function launcher() {
  const root = join(await temporary(), 'Harness с пробелами');
  const archiveSource = join(root, 'archive-source');
  const staged = join(archiveSource, release);
  const fakeBin = join(root, 'fake-bin');
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(staged, 'bin'), { recursive: true });
  await mkdir(join(staged, 'lib/node_modules/npm/bin'), { recursive: true });
  await mkdir(fakeBin);
  for (const file of [
    'install-runtime.mjs',
    'project-lock.mjs',
    'build-state.mjs',
    'preparation-command.mjs',
  ])
    await cp(join(repository, 'scripts', file), join(root, 'scripts', file));
  await cp(join(repository, 'start.sh'), join(root, 'start.sh'));
  await writeFile(join(root, '.nvmrc'), '24.21.0\n');
  await writeFile(join(staged, 'bin/node'), '#!/bin/sh\nexec "$HARNESS_TEST_NODE" "$@"\n');
  await chmod(join(staged, 'bin/node'), 0o755);
  await writeFile(join(staged, 'lib/node_modules/npm/bin/npm-cli.js'), "console.log('11.12.0');\n");
  await symlink('../lib/node_modules/npm/bin/npm-cli.js', join(staged, 'bin/npm'));
  await writeFile(
    join(root, 'scripts/bootstrap.mjs'),
    "console.log('BOOTSTRAP_READY ' + JSON.stringify(process.argv.slice(2)));\n",
  );
  const archive = join(archiveSource, release + '.tar.gz');
  await execute('tar', ['-czf', archive, '-C', archiveSource, release]);
  await writeFile(
    join(archiveSource, 'SHASUMS256.txt'),
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex') +
      '  ' +
      release +
      '.tar.gz\n',
  );
  const curl = join(fakeBin, 'curl');
  await writeFile(
    curl,
    '#!/bin/sh\n' +
      'while [ "$#" -gt 0 ]; do\n' +
      '  if [ "$1" = "--output" ]; then shift; output="$1"; else url="$1"; fi\n' +
      '  shift\n' +
      'done\n' +
      'cp "$HARNESS_TEST_DOWNLOAD/${url##*/}" "$output"\n',
  );
  await chmod(curl, 0o755);
  const env = {
    ...process.env,
    HARNESS_TEST_NODE: process.execPath,
    HARNESS_TEST_DOWNLOAD: archiveSource,
    PATH: fakeBin + ':' + process.env.PATH,
  };
  return {
    root,
    staged,
    env,
    destination: join(root, '.tools', release),
    start: () =>
      execute('/bin/sh', ['start.sh', '--prepare-only', '--label', 'слова с пробелами'], {
        cwd: root,
        env,
        timeout: 20_000,
      }),
    install: () =>
      execute(process.execPath, ['scripts/install-runtime.mjs', staged, release], {
        cwd: root,
        env,
        timeout: 20_000,
      }),
  };
}

it.skipIf(process.platform === 'win32')(
  'файл запуска устанавливает runtime, сохраняет аргументы и чинит неполный кэш Node/npm',
  async () => {
    const fixture = await launcher();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, 'incomplete.txt'), 'прерванная установка');
    const first = await fixture.start();
    expect(first.stdout).toContain(
      'BOOTSTRAP_READY ["--prepare-only","--label","слова с пробелами"]',
    );
    expect(await readdir(fixture.destination)).not.toContain('incomplete.txt');
    expect(await readlink(join(fixture.destination, 'bin/npm'))).toBe(
      '../lib/node_modules/npm/bin/npm-cli.js',
    );
    expect(
      (
        await execute(process.execPath, [join(fixture.destination, 'bin/npm'), '--version'], {
          env: fixture.env,
        })
      ).stdout.trim(),
    ).toBe('11.12.0');
    const installed = await stat(join(fixture.destination, 'bin/node'));
    const cached = await fixture.start();
    expect(cached.stdout).not.toContain('загружаю Node.js');
    expect((await stat(join(fixture.destination, 'bin/node'))).mtimeMs).toBe(installed.mtimeMs);
    await rm(join(fixture.destination, 'lib/node_modules/npm/bin/npm-cli.js'));
    expect((await fixture.start()).stdout).toContain('BOOTSTRAP_READY');
    expect(await readdir(join(fixture.root, '.tools'))).toEqual([release]);
  },
  40_000,
);

it.skipIf(process.platform === 'win32')(
  'параллельная публикация runtime оставляет одну целую папку без вложенного дубликата',
  async () => {
    const fixture = await launcher();
    const results = await Promise.allSettled([fixture.install(), fixture.install()]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason.stderr).toContain('Дождитесь завершения другой подготовки');
    }
    expect(await readdir(fixture.destination)).toEqual(['bin', 'lib']);
    expect(await readdir(join(fixture.root, '.tools'))).toEqual([release]);
    expect((await fixture.start()).stdout).toContain('BOOTSTRAP_READY');
  },
  30_000,
);
