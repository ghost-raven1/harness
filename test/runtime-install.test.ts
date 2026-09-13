import { execFile, spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const repository = resolve('.');
const release = `node-v24.21.0-${process.platform}-${process.arch}`;

/** Настоящий Node исполняет локальный npm-fixture; загрузок и пользовательского состояния нет. */
async function installer() {
  const root = join(await temporary(), 'runtime [проверка] с пробелами');
  await mkdir(join(root, 'scripts'), { recursive: true });
  for (const file of [
    'install-runtime.mjs',
    'project-lock.mjs',
    'build-state.mjs',
    'preparation-command.mjs',
  ])
    await cp(join(repository, 'scripts', file), join(root, 'scripts', file));
  await writeFile(join(root, '.nvmrc'), '24.21.0\n');
  const source = join(root, 'download', release);
  const destination = join(root, '.tools', release);
  async function runtime(directory: string, code = "console.log('11.12.0');") {
    await mkdir(join(directory, 'bin'), { recursive: true });
    await mkdir(join(directory, 'lib/node_modules/npm/bin'), { recursive: true });
    await writeFile(join(directory, 'bin/node'), '#!/bin/sh\nexec "$HARNESS_TEST_NODE" "$@"\n');
    await chmod(join(directory, 'bin/node'), 0o755);
    await writeFile(join(directory, 'lib/node_modules/npm/bin/npm-cli.js'), code);
  }
  await runtime(source);
  return {
    root,
    source,
    destination,
    runtime,
    script: join(root, 'scripts/install-runtime.mjs'),
    env: { ...process.env, HARNESS_TEST_NODE: process.execPath },
  };
}

/** Ожидание короткого сигнала готовности ограничено; таймаут не оставляет зависший тест. */
async function waitForPid(path: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Проверочный npm не сообщил о запуске.');
}

it.skipIf(process.platform === 'win32')(
  'отмена завершает npm, игнорирующий SIGTERM, и сохраняет прежний runtime',
  async () => {
    const fixture = await installer();
    const pidFile = join(fixture.root, 'npm.pid');
    await fixture.runtime(
      fixture.destination,
      "process.on('SIGTERM', () => {});\n" +
        "require('node:fs').writeFileSync(process.env.HARNESS_TEST_PID, String(process.pid));\n" +
        'setInterval(() => {}, 1000);\n',
    );
    const marker = join(fixture.destination, 'previous.txt');
    await writeFile(marker, 'предыдущая установка');
    const child = spawn(process.execPath, [fixture.script, fixture.source, release], {
      cwd: resolve('/tmp'),
      env: { ...fixture.env, HARNESS_TEST_PID: pidFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<number | null>((done, fail) => {
      child.once('error', fail);
      child.once('close', done);
    });
    let probe: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      probe = await waitForPid(pidFile);
      child.kill('SIGTERM');
      const code = await Promise.race([
        closed,
        new Promise<never>((_, fail) => {
          timeout = setTimeout(() => fail(new Error('Отмена не завершила установщик.')), 5000);
        }),
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain('Подготовка прервана');
      expect(() => process.kill(probe!, 0)).toThrow();
      expect(await readFile(marker, 'utf8')).toBe('предыдущая установка');
      expect(await readdir(join(fixture.root, '.tools'))).toEqual([release]);
    } finally {
      clearTimeout(timeout);
      if (probe) {
        try {
          process.kill(probe, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'ошибка публикации возвращает прежний каталог и удаляет только неудавшуюся копию',
  async () => {
    const fixture = await installer();
    await mkdir(fixture.destination, { recursive: true });
    await writeFile(join(fixture.destination, 'previous.txt'), 'предыдущая установка');
    const loader = join(fixture.root, 'deny-publication.mjs');
    await writeFile(
      loader,
      "import fs from 'node:fs/promises';\n" +
        "import { syncBuiltinESMExports } from 'node:module';\n" +
        'const original = fs.rename;\n' +
        'fs.rename = async (from, to) => {\n' +
        "  if (String(from).endsWith('/candidate')) throw Object.assign(new Error('FIXTURE_PUBLICATION_DENIED'), { code: 'EACCES' });\n" +
        '  return original(from, to);\n' +
        '};\nsyncBuiltinESMExports();\n',
    );
    const result = await execute(
      process.execPath,
      ['--import', loader, fixture.script, fixture.source, release],
      { cwd: resolve('/tmp'), env: fixture.env, timeout: 10_000 },
    ).then(
      () => undefined,
      (error: { code: number; stderr: string }) => error,
    );
    expect(result?.code).toBe(1);
    expect(result?.stderr).toContain('FIXTURE_PUBLICATION_DENIED');
    expect(await readFile(join(fixture.destination, 'previous.txt'), 'utf8')).toBe(
      'предыдущая установка',
    );
    expect(await readdir(fixture.destination)).toEqual(['previous.txt']);
    expect(await readdir(join(fixture.root, '.tools'))).toEqual([release]);
    expect((await stat(join(fixture.source, 'bin/node'))).isFile()).toBe(true);
  },
);
