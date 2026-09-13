import { execFile, spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const repository = resolve('.');

/** Настоящий компилятор работает только с маленьким временным проектом. */
async function project() {
  const root = join(await temporary(), 'проект сборки');
  await mkdir(join(root, 'src/interfaces'), { recursive: true });
  await cp(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
  await symlink(
    join(repository, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(
    join(root, 'package.json'),
    '{"name":"build-fixture","version":"1.0.0","type":"module"}',
  );
  await writeFile(join(root, 'package-lock.json'), '{}');
  await writeFile(join(root, '.npmrc'), 'engine-strict=true\n');
  await writeFile(join(root, '.nvmrc'), process.version.slice(1));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rootDir: 'src',
        outDir: 'dist',
        declaration: true,
        sourceMap: true,
        types: [],
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(join(root, 'tsconfig.build.json'), '{"extends":"./tsconfig.json"}');
  await writeFile(
    join(root, 'src/interfaces/cli.ts'),
    "export const version: number = 1; console.log('READY');\n",
  );
  return root;
}
const build = (root: string, preload?: string) =>
  execute(
    process.execPath,
    [...(preload ? ['--import', preload] : []), join(root, 'scripts/build.mjs')],
    { cwd: root, timeout: 15000 },
  );
const manifest = (root: string) => readFile(join(root, 'dist/build-manifest.json'), 'utf8');

it.each(['zero', 'ignore'])(
  'таймаут остаётся ошибкой при обработчике SIGTERM: %s',
  async (mode) => {
    const root = await temporary();
    const runner = join(root, 'timeout.mjs');
    const command =
      "process.on('SIGTERM',()=>{" +
      (mode === 'zero' ? 'process.exit(0)' : '') +
      '});setInterval(()=>{},1000);';
    await writeFile(
      runner,
      `import {buildCommand} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/build.mjs')).href)};await buildCommand(${JSON.stringify(root)},['-e',${JSON.stringify(command)}],{timeoutMs:200,stdio:'ignore'});`,
    );
    await expect(execute(process.execPath, [runner], { timeout: 5000 })).rejects.toThrow(
      'Превышено время',
    );
  },
);

it('повторная сборка воспроизводима, удаляет старые модули и сохраняет пути source maps', async () => {
  const root = await project();
  await writeFile(join(root, 'src/old.ts'), 'export const obsolete = true;');
  await build(root);
  const first = await manifest(root);
  await build(root);
  expect(await manifest(root)).toBe(first);
  await rm(join(root, 'src/old.ts'));
  await build(root);
  await expect(readFile(join(root, 'dist/old.js'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(root, 'dist/old.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  const mapPath = join(root, 'dist/interfaces/cli.js.map');
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  expect(resolve(dirname(mapPath), map.sources[0])).toBe(join(root, 'src/interfaces/cli.ts'));
}, 30000);

it.each(['type', 'startup', 'hang'])(
  'ошибка %s не меняет последнюю рабочую сборку',
  async (kind) => {
    const root = await project();
    await build(root);
    const first = await manifest(root);
    const cli = await readFile(join(root, 'dist/interfaces/cli.js'), 'utf8');
    await writeFile(
      join(root, 'src/interfaces/cli.ts'),
      kind === 'type'
        ? 'export const value: number = "broken";'
        : kind === 'startup'
          ? 'throw new Error("STARTUP_FAILURE");'
          : 'setInterval(() => {}, 1000);',
    );
    await expect(build(root)).rejects.toThrow();
    expect(await manifest(root)).toBe(first);
    expect(await readFile(join(root, 'dist/interfaces/cli.js'), 'utf8')).toBe(cli);
    expect((await readdir(root)).filter((name) => name.startsWith('.harness-'))).toEqual([]);
    expect(
      (await execute(process.execPath, [join(root, 'dist/interfaces/cli.js'), '--help'])).stdout,
    ).toContain('READY');
  },
  30000,
);

it('ошибка публикации откатывает каталог, а прерванная замена восстанавливается до компиляции', async () => {
  const root = await project();
  await build(root);
  const first = await manifest(root);
  const loader = join(root, 'fail-rename.mjs');
  await writeFile(
    loader,
    `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
const rename=fs.rename; fs.rename=async (from,to)=>{if(String(from).includes('.harness-build-') && to===${JSON.stringify(join(root, 'dist'))}) throw Object.assign(new Error('PUBLISH_FAILURE'),{code:'EACCES'}); return rename(from,to)}; syncBuiltinESMExports();`,
  );
  await expect(build(root, loader)).rejects.toThrow('PUBLISH_FAILURE');
  expect(await manifest(root)).toBe(first);
  await rename(join(root, 'dist'), join(root, '.harness-dist-backup'));
  await writeFile(join(root, 'src/interfaces/cli.ts'), 'const value: number = "broken";');
  await expect(build(root)).rejects.toThrow();
  expect(await manifest(root)).toBe(first);
}, 30000);

it('параллельная подготовка не входит в занятый проект; авария владельца освобождает mutex', async () => {
  const root = await project();
  const runner = join(root, 'lock-test.mjs');
  await writeFile(
    runner,
    `import {withProjectLock} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/project-lock.mjs')).href)};
await withProjectLock(${JSON.stringify(root)}, async()=>{console.log('LOCKED');await new Promise(r=>setTimeout(r,30000));});`,
  );
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  try {
    await new Promise<void>((done, fail) => {
      child.once('error', fail);
      child.stdout.once('data', () => done());
      child.once('close', () => fail(new Error('Владелец не запустился')));
    });
    const results = await Promise.allSettled([build(root), build(root)]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(readFile(join(root, 'dist/interfaces/cli.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  await build(root);
  expect(await manifest(root)).toContain('interfaces/cli.js');
});

it('старый пустой lock не блокирует следующие запуски навсегда', async () => {
  const root = await project();
  await mkdir(join(root, '.tools'));
  const path = join(root, '.tools/prepare.lock');
  await writeFile(path, '');
  const old = new Date(Date.now() - 60000);
  await utimes(path, old, old);
  await build(root);
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('отмена компиляции сохраняет старую сборку и освобождает подготовку', async () => {
  const root = await project();
  await build(root);
  const previous = await manifest(root);
  const runner = join(root, 'cancel-build.mjs');
  await writeFile(
    runner,
    `import {withProjectLock} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/project-lock.mjs')).href)};
import {buildProject} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/build.mjs')).href)};
await withProjectLock(${JSON.stringify(root)}, async lease=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),200);try{await buildProject(${JSON.stringify(root)},{...lease,signal:controller.signal})}finally{clearTimeout(timer)}});`,
  );
  await expect(
    execute(process.execPath, [runner], { cwd: root, timeout: 10000 }),
  ).rejects.toThrow();
  expect(await manifest(root)).toBe(previous);
  expect((await readdir(root)).filter((name) => name.startsWith('.harness-'))).toEqual([]);
  await expect(readFile(join(root, '.tools/prepare.lock'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
