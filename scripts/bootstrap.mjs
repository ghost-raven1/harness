import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInputs, validBuild, writeJsonAtomic } from './build-state.mjs';
import { buildCommand, buildProject } from './build.mjs';
import { withProjectLock } from './project-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
const cache = join(root, '.tools');
const marker = join(cache, 'prepared.json');
const log = join(cache, 'setup.log');
const npmCli =
  process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const environment = {
  ...process.env,
  PATH:
    dirname(process.execPath) +
    (process.platform === 'win32' ? ';' : ':') +
    (process.env.PATH ?? ''),
};

/** Подробный вывод остаётся в журнале; код возврата позволяет проверить повреждённый кэш. */
async function npmCommand(args, signal) {
  const command = [npmCli, ...args];
  await appendFile(log, '\n' + new Date().toISOString() + ' node ' + command.join(' ') + '\n');
  const handle = await open(log, 'a', 0o600);
  try {
    return await buildCommand(root, command, {
      env: environment,
      signal,
      stdio: ['ignore', handle.fd, handle.fd],
      allowFailure: true,
      timeoutMs: args[0] === 'ls' ? 60_000 : 15 * 60_000,
    });
  } finally {
    await handle.close();
  }
}

/** Проверяет всё обязательное дерево, включая dev tools для локальной компиляции. */
async function dependenciesReady(signal) {
  return (await npmCommand(['ls', '--all', '--omit=optional', '--include=dev'], signal)) === 0;
}

/** Проверка справки ограничена по времени и не открывает пользовательское состояние. */
async function cliReady(signal) {
  const state = await mkdtemp(join(cache, 'cli-check-'));
  let handle;
  try {
    await appendFile(log, '\n' + new Date().toISOString() + ' CLI --help\n');
    handle = await open(log, 'a', 0o600);
    await buildCommand(root, [join(root, 'dist/interfaces/cli.js'), '--help'], {
      stdio: ['ignore', handle.fd, handle.fd],
      signal,
      timeoutMs: 10_000,
      env: { ...environment, HARNESS_STATE_DIR: state },
    });
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    await appendFile(log, 'Проверка CLI не пройдена: ' + error.message + '\n');
    return false;
  } finally {
    await handle?.close();
    await rm(state, { recursive: true, force: true });
  }
}

/** Один владелец устанавливает зависимости и публикует только проверенную сборку. */
async function prepare() {
  if (process.version !== 'v' + version)
    throw new Error('Нужен Node.js ' + version + '. Откройте файл запуска для вашей системы.');
  await mkdir(cache, { recursive: true });
  await withProjectLock(root, async (lease) => {
    let previous = {};
    try {
      previous = JSON.parse(await readFile(marker, 'utf8'));
    } catch {
      /* Первый запуск или прерванная запись потребуют повторной проверки. */
    }
    let inputs = await buildInputs(root);
    const built = await validBuild(root, inputs);
    const installed =
      previous?.dependencies === inputs.dependencies &&
      (await dependenciesReady(lease.signal)) &&
      (!built || (await cliReady(lease.signal)));
    if (!installed) {
      console.log('[1/3] Устанавливаю библиотеки. Первый запуск может занять несколько минут…');
      await lease.assertOwned();
      const installCode = await npmCommand(
        ['ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'],
        lease.signal,
      );
      if (installCode !== 0 || !(await dependenciesReady(lease.signal)))
        throw new Error('Не удалось установить библиотеки. Подробности: ' + log);
    } else console.log('[1/3] Библиотеки готовы');
    await lease.assertOwned();
    if (!built) {
      console.log('[2/3] Подготавливаю приложение…');
      await appendFile(log, '\n' + new Date().toISOString() + ' build\n');
      const handle = await open(log, 'a', 0o600);
      try {
        inputs = await buildProject(root, {
          stdio: ['ignore', handle.fd, handle.fd],
          signal: lease.signal,
          assertOwned: lease.assertOwned,
        });
      } catch (error) {
        throw new Error(error.message + '\nПодробности: ' + log);
      } finally {
        await handle.close();
      }
    } else {
      if (!installed && !(await cliReady(lease.signal)))
        throw new Error('Не удалось проверить запуск приложения. Подробности: ' + log);
      console.log('[2/3] Приложение готово');
    }
    await lease.assertOwned();
    if (JSON.stringify(inputs) !== JSON.stringify(await buildInputs(root)))
      throw new Error('Файлы проекта изменились во время подготовки. Повторите запуск.');
    await writeJsonAtomic(marker, inputs);
  });
}

try {
  await prepare();
  const args = process.argv.slice(2);
  if (args[0] === '--prepare-only')
    console.log('[3/3] Всё готово. Откройте файл запуска, чтобы начать работу.');
  else {
    console.log('[3/3] Открываю Harness');
    const child = spawn(process.execPath, [join(root, 'dist/interfaces/cli.js'), ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  }
} catch (error) {
  console.error('\nНе получилось открыть Harness.\n' + error.message);
  process.exitCode = 1;
}
