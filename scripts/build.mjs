import { mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInputs,
  inventory,
  manifestName,
  validBuild,
  writeJsonAtomic,
} from './build-state.mjs';
import { withProjectLock } from './project-lock.mjs';
import { runPreparationCommand } from './preparation-command.mjs';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Ожидает закрытия процесса, включая отмену: незавершённый компилятор не публикует результат. */
export async function buildCommand(root, args, options) {
  return (await runPreparationCommand(root, args, options)).code;
}

/** Вызывается под withProjectLock; рабочая сборка заменяется только целиком после всех проверок. */
export async function buildProject(root, options = {}) {
  const expected = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  if (process.version !== 'v' + expected)
    throw new Error('Для сборки нужен Node.js ' + expected + '.');
  const target = join(root, 'dist');
  const backup = join(root, '.harness-dist-backup');
  await options.assertOwned?.();
  if (await exists(backup)) {
    if (await validBuild(root, undefined, target)) await rm(backup, { recursive: true });
    else {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target);
    }
  }
  const inputs = await buildInputs(root);
  // Та же глубина каталога сохраняет относительные пути source maps после публикации.
  const stage = await mkdtemp(join(root, '.harness-build-'));
  try {
    await buildCommand(
      root,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '-p',
        join(root, 'tsconfig.build.json'),
        '--outDir',
        stage,
        '--noEmitOnError',
      ],
      options,
    );
    await buildCommand(root, [join(stage, 'interfaces/cli.js'), '--help'], {
      ...options,
      timeoutMs: 10000,
      env: { ...process.env, HARNESS_STATE_DIR: join(stage, '.smoke-state') },
    });
    await writeJsonAtomic(join(stage, manifestName), {
      schemaVersion: 1,
      ...inputs,
      files: await inventory(stage),
    });
    const after = await buildInputs(root);
    if (JSON.stringify(inputs) !== JSON.stringify(after))
      throw new Error(
        'Исходники изменились во время сборки. Повторите сборку; прежняя версия сохранена.',
      );
    await options.assertOwned?.();
    options.signal?.throwIfAborted();
    if (await exists(target)) await rename(target, backup);
    try {
      await rename(stage, target);
    } catch (error) {
      if (await exists(backup)) await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return inputs;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    await mkdir(join(root, '.tools'), { recursive: true });
    await withProjectLock(root, (lease) => buildProject(root, lease));
    console.log('Сборка готова. Проверены компиляция, запуск CLI и целостность файлов.');
  } catch (error) {
    console.error('Сборка не завершена: ' + error.message);
    process.exitCode = 1;
  }
}
