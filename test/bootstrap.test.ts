import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import { temporary } from './helpers.js';
import { stopProcessTree } from '../src/tools/process.js';

const execute = promisify(execFile);
const repository = resolve('.');
// Установка локальных пакетов на Windows включает более медленные операции с файлами.
const timeoutFactor = process.platform === 'win32' ? 3 : 1;
const npm = join(
  dirname(process.execPath),
  process.platform === 'win32'
    ? 'node_modules/npm/bin/npm-cli.js'
    : '../lib/node_modules/npm/bin/npm-cli.js',
);

/** Локальные пакеты проверяют настоящую установку npm без обращения к реестру. */
async function project() {
  const directory = await temporary();
  const root = join(directory, 'проект с пробелами');
  const dependency = join(directory, 'required-package');
  await mkdir(join(root, 'src/interfaces'), { recursive: true });
  await mkdir(dependency);
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({
      name: 'fixture-required',
      version: '1.0.0',
      main: 'index.js',
      types: 'index.d.ts',
    }),
  );
  await writeFile(
    join(dependency, 'index.js'),
    'if (process.env.HARNESS_TEST_STATE_REPORT) {\n' +
      "  require('node:fs').appendFileSync(process.env.HARNESS_TEST_STATE_REPORT, JSON.stringify(process.env.HARNESS_STATE_DIR) + '\\n');\n" +
      "  if (process.env.HARNESS_TEST_HELP_CRASH === '1') throw new Error('HELP_FIXTURE_CRASH');\n" +
      '}\nmodule.exports = true;\n',
  );
  await writeFile(
    join(dependency, 'index.d.ts'),
    'declare const ready: boolean; export = ready;\n',
  );
  await cp(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'bootstrap-fixture',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { 'fixture-required': 'file:' + dependency },
      devDependencies: { typescript: 'file:' + join(repository, 'node_modules/typescript') },
      scripts: { build: 'node scripts/build.mjs' },
    }),
  );
  await writeFile(join(root, '.nvmrc'), '24.21.0\n');
  await writeFile(
    join(root, '.npmrc'),
    'engine-strict=true\ninstall-links=true\nregistry=http://127.0.0.1:9\nfetch-retries=0\ncache=.npm-cache\n',
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: 'src',
        outDir: 'dist',
        strict: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(join(root, 'tsconfig.build.json'), '{"extends":"./tsconfig.json"}');
  await writeFile(
    join(root, 'src/interfaces/cli.ts'),
    "import ready from 'fixture-required'; console.log('HARNESS_FIXTURE_READY', ready);\n",
  );
  await execute(
    process.execPath,
    [npm, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: root, timeout: 15_000 },
  );
  return root;
}

/** Среда production не должна убирать компилятор из локального приложения. */
async function prepare(root: string, timeoutMs = 20_000 * timeoutFactor) {
  const child = spawn(process.execPath, ['scripts/bootstrap.mjs', '--prepare-only'], {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev' },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => (stdout += String(data)));
  child.stderr.on('data', (data) => (stderr += String(data)));
  const execution = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Подготовка завершилась: ${code ?? signal}\n${stderr}`));
    });
  });
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  const timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    timedOut = true;
    stopping = (async () => {
      if (process.platform !== 'win32') {
        // Владелец передаст отмену отдельным группам npm и компилятора через lease.signal.
        child.kill('SIGTERM');
        await Promise.race([execution.catch(() => {}), delay(1500)]);
      }
      // Windows завершает дерево целиком; на POSIX это запасной выход для зависшего владельца.
      await stopProcessTree(child.pid!).catch(() => {
        child.kill('SIGKILL');
      });
    })();
  }, timeoutMs);
  try {
    const result = await execution;
    if (timedOut) throw new Error('Превышено время тестовой подготовки.');
    return result;
  } catch (error) {
    await stopping;
    throw new Error(
      (timedOut ? 'Превышено время тестовой подготовки.' : String(error)) +
        '\n' +
        (await readFile(join(root, '.tools/setup.log'), 'utf8')),
    );
  } finally {
    clearTimeout(timer);
    await stopping;
  }
}

it(
  'чистая установка с пробелами в пути включает dev tools и повторно использует исправный кэш',
  async () => {
    const root = await project();
    const first = await prepare(root);
    expect(first.stdout).toContain('Всё готово');
    expect(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).toContain(
      'typescript',
    );
    const compiled = join(root, 'dist/interfaces/cli.js');
    const before = await stat(compiled);
    // У старой версии есть только prepared.json; обновление не требует новой установки.
    await rm(join(root, '.tools/dependencies.json'));
    const second = await prepare(root);
    expect(second.stdout).toContain('Библиотеки готовы');
    expect(second.stdout).toContain('Приложение готово');
    expect((await stat(compiled)).mtimeMs).toBe(before.mtimeMs);
    expect(
      JSON.parse(await readFile(join(root, '.tools/dependencies.json'), 'utf8')),
    ).toHaveProperty('dependencies');
    const log = await readFile(join(root, '.tools/setup.log'), 'utf8');
    expect(log.match(/npm-cli\.js ci /g)).toHaveLength(1);
    for (const stage of ['npm-ci', 'npm-ls', 'build', 'CLI --help']) {
      expect(log).toContain('stage=' + stage + ' start');
      expect(log).toMatch(new RegExp('stage=' + stage + ' finish status=ok elapsedMs=\\d+'));
    }
    expect((await execute(process.execPath, [compiled, '--help'], { cwd: root })).stdout).toContain(
      'HARNESS_FIXTURE_READY',
    );
  },
  40_000 * timeoutFactor,
);

it(
  'повторная подготовка чинит удалённый обязательный пакет и повреждённый результат сборки',
  async () => {
    const root = await project();
    await prepare(root);
    await rm(join(root, 'node_modules/fixture-required'), { recursive: true, force: true });
    const repaired = await prepare(root);
    expect(repaired.stdout).toContain('Устанавливаю библиотеки');
    expect(
      await readFile(join(root, 'node_modules/fixture-required/package.json'), 'utf8'),
    ).toContain('fixture-required');
    await rm(join(root, 'node_modules/fixture-required/index.js'));
    expect((await prepare(root)).stdout).toContain('Устанавливаю библиотеки');
    expect(await readFile(join(root, 'node_modules/fixture-required/index.js'), 'utf8')).toContain(
      'module.exports',
    );
    const compiled = join(root, 'dist/interfaces/cli.js');
    await writeFile(compiled, "throw new Error('BROKEN_BUILD');\n");
    await prepare(root);
    const run = await execute(process.execPath, [compiled, '--help'], { cwd: root });
    expect(run.stdout).toContain('HARNESS_FIXTURE_READY');
    expect(run.stderr).toBe('');
  },
  60_000 * timeoutFactor,
);

it(
  'падение справки не выдаёт готовность и не затрагивает исходный каталог состояния',
  async () => {
    const root = await project();
    await prepare(root);
    const preserved = join(root, 'состояние пользователя');
    const report = join(root, 'help-states.jsonl');
    await mkdir(preserved);
    await writeFile(join(preserved, 'keep.txt'), 'сохранённые данные');
    const marker = await stat(join(root, '.tools/prepared.json'));
    const result = await execute(process.execPath, ['scripts/bootstrap.mjs', '--prepare-only'], {
      cwd: root,
      timeout: 20_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        npm_config_omit: 'dev',
        HARNESS_STATE_DIR: preserved,
        HARNESS_TEST_STATE_REPORT: report,
        HARNESS_TEST_HELP_CRASH: '1',
      },
    }).then(
      () => undefined,
      (error: { code: number; stdout: string; stderr: string }) => error,
    );
    expect(result?.code).toBe(1);
    expect(result?.stdout).not.toContain('Всё готово');
    expect(result?.stderr).toContain('Не удалось проверить запуск приложения');
    const states = (await readFile(report, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(states).toHaveLength(2);
    expect(new Set(states).size).toBe(2);
    for (const state of states) {
      expect(state).not.toBe(preserved);
      await expect(stat(state)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await readdir(preserved)).toEqual(['keep.txt']);
    expect(await readFile(join(preserved, 'keep.txt'), 'utf8')).toBe('сохранённые данные');
    expect((await stat(join(root, '.tools/prepared.json'))).mtimeMs).toBe(marker.mtimeMs);
  },
  40_000 * timeoutFactor,
);

it(
  'некорректные JSON-маркеры восстанавливаются вместо внутренней ошибки',
  async () => {
    const root = await project();
    await prepare(root);
    await writeFile(join(root, '.tools/prepared.json'), 'null');
    await writeFile(join(root, 'dist/build-manifest.json'), 'null');
    const result = await prepare(root);
    expect(result.stdout).toContain('Всё готово');
    expect(result.stdout).toContain('Библиотеки готовы');
    expect(
      (await readFile(join(root, '.tools/setup.log'), 'utf8')).match(/npm-cli\.js ci /g),
    ).toHaveLength(1);
    expect(JSON.parse(await readFile(join(root, '.tools/prepared.json'), 'utf8'))).toHaveProperty(
      'dependencies',
    );
    expect(
      JSON.parse(await readFile(join(root, 'dist/build-manifest.json'), 'utf8')).schemaVersion,
    ).toBe(1);
  },
  40_000 * timeoutFactor,
);

it(
  'изменение lockfile требует новой установки, даже когда дерево npm исправно',
  async () => {
    const root = await project();
    await prepare(root);
    const marker = join(root, '.tools/dependencies.json');
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    const lockfile = join(root, 'package-lock.json');
    const lock = JSON.parse(await readFile(lockfile, 'utf8'));
    lock.packages[''].license = 'UNLICENSED';
    await writeFile(lockfile, JSON.stringify(lock));
    const result = await prepare(root);
    expect(result.stdout).toContain('Устанавливаю библиотеки');
    expect(JSON.parse(await readFile(marker, 'utf8')).dependencies).not.toBe(previous.dependencies);
    expect(
      (await readFile(join(root, '.tools/setup.log'), 'utf8')).match(/npm-cli\.js ci /g),
    ).toHaveLength(2);
  },
  40_000 * timeoutFactor,
);

it(
  'ошибка сборки сохраняет проверенную установку для следующей попытки',
  async () => {
    const root = await project();
    const source = join(root, 'src/interfaces/cli.ts');
    const valid = await readFile(source, 'utf8');
    await writeFile(source, 'const value: number = "ошибка";');
    await expect(prepare(root)).rejects.toThrow('Подготовка завершилась');
    expect(await readFile(join(root, '.tools/setup.log'), 'utf8')).toMatch(
      /stage=build finish status=error elapsedMs=\d+/,
    );
    await expect(stat(join(root, '.tools/prepared.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      JSON.parse(await readFile(join(root, '.tools/dependencies.json'), 'utf8')),
    ).toHaveProperty('dependencies');
    await writeFile(source, valid);
    const result = await prepare(root);
    expect(result.stdout).toContain('Библиотеки готовы');
    expect(result.stdout).toContain('Всё готово');
    expect(
      (await readFile(join(root, '.tools/setup.log'), 'utf8')).match(/npm-cli\.js ci /g),
    ).toHaveLength(1);
  },
  40_000 * timeoutFactor,
);

it('таймаут тестовой подготовки завершает дочерний процесс до удаления временной папки', async () => {
  const root = await temporary();
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.tools'));
  await writeFile(join(root, '.tools/setup.log'), 'Тестовая подготовка');
  await writeFile(
    join(root, 'scripts/bootstrap.mjs'),
    `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
writeFileSync('child.pid', String(child.pid));
setInterval(() => {}, 1000);`,
  );
  await expect(prepare(root, 3000)).rejects.toThrow('Превышено время тестовой подготовки');
  const pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
  expect(pid).toBeGreaterThan(0);
  // Живой потомок удерживал бы унаследованный pipe и не дал бы prepare дождаться close.
  await rm(root, { recursive: true });
});

it.skipIf(process.platform === 'win32')(
  'отмена зависшего npm завершает подготовку и освобождает проект',
  async () => {
    const root = await project();
    await prepare(root);
    const marker = await readFile(join(root, '.tools/prepared.json'), 'utf8');
    const pidFile = join(root, 'npm-pid.txt');
    const preload = join(root, 'blocked-npm.mjs');
    const blocked = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    await writeFile(
      preload,
      `import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawn;childProcess.spawn=(command,args,options)=>original(command,args[0]?.endsWith('npm-cli.js')?['-e',${JSON.stringify(blocked)}]:args,options);syncBuiltinESMExports();`,
    );
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        join(root, 'scripts/bootstrap.mjs'),
        '--prepare-only',
      ],
      {
        cwd: root,
        stdio: 'ignore',
      },
    );
    const closed = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
    let npmPid: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.waitFor(
        async () => {
          npmPid = Number(await readFile(pidFile, 'utf8'));
          expect(npmPid).toBeGreaterThan(0);
        },
        { timeout: 10000 },
      );
      child.kill('SIGTERM');
      const result = await Promise.race([
        closed,
        new Promise((done) => {
          timeout = setTimeout(() => done('still-running'), 3000);
        }),
      ]);
      expect(result).toBe(1);
      await expect(stat(join(root, '.tools/prepare.lock'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(root, '.tools/prepared.json'), 'utf8')).toBe(marker);
      expect((await prepare(root)).stdout).toContain('Всё готово');
    } finally {
      clearTimeout(timeout);
      if (npmPid) {
        try {
          process.kill(npmPid, 'SIGKILL');
        } catch {
          /* Завершённый процесс уже отсутствует. */
        }
      }
      child.kill('SIGKILL');
      await closed;
    }
  },
  40000,
);
