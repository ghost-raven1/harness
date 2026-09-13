import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const repository = resolve('.');
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
async function prepare(root: string) {
  try {
    return await execute(process.execPath, ['scripts/bootstrap.mjs', '--prepare-only'], {
      cwd: root,
      timeout: 20_000,
      env: { ...process.env, NODE_ENV: 'production', npm_config_omit: 'dev' },
    });
  } catch (error) {
    throw new Error(
      String(error) + '\n' + (await readFile(join(root, '.tools/setup.log'), 'utf8')),
    );
  }
}

it('чистая установка с пробелами в пути включает dev tools и повторно использует исправный кэш', async () => {
  const root = await project();
  const first = await prepare(root);
  expect(first.stdout).toContain('Всё готово');
  expect(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).toContain(
    'typescript',
  );
  const compiled = join(root, 'dist/interfaces/cli.js');
  const before = await stat(compiled);
  const second = await prepare(root);
  expect(second.stdout).toContain('Библиотеки готовы');
  expect(second.stdout).toContain('Приложение готово');
  expect((await stat(compiled)).mtimeMs).toBe(before.mtimeMs);
  expect((await execute(process.execPath, [compiled, '--help'], { cwd: root })).stdout).toContain(
    'HARNESS_FIXTURE_READY',
  );
}, 40_000);

it('повторная подготовка чинит удалённый обязательный пакет и повреждённый результат сборки', async () => {
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
}, 60_000);

it('падение справки не выдаёт готовность и не затрагивает исходный каталог состояния', async () => {
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
}, 40_000);

it('некорректные JSON-маркеры восстанавливаются вместо внутренней ошибки', async () => {
  const root = await project();
  await prepare(root);
  await writeFile(join(root, '.tools/prepared.json'), 'null');
  await writeFile(join(root, 'dist/build-manifest.json'), 'null');
  const result = await prepare(root);
  expect(result.stdout).toContain('Всё готово');
  expect(JSON.parse(await readFile(join(root, '.tools/prepared.json'), 'utf8'))).toHaveProperty(
    'dependencies',
  );
  expect(
    JSON.parse(await readFile(join(root, 'dist/build-manifest.json'), 'utf8')).schemaVersion,
  ).toBe(1);
}, 40_000);

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
