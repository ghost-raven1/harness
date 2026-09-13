import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreparationCommand } from './preparation-command.mjs';
import { withProjectLock } from './project-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Наличие исполняемого файла не доказывает, что локальные Node и npm работают. */
async function runtimeReady(directory, version, signal) {
  const node = join(directory, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const npm = join(
    directory,
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : 'lib/node_modules/npm/bin/npm-cli.js',
  );
  try {
    const options = { executable: node, captureOutput: true, timeoutMs: 15_000, signal };
    const actual = await runPreparationCommand(root, ['--version'], options);
    if (actual.stdout.trim() !== 'v' + version) return false;
    return /^11\./.test(
      (await runPreparationCommand(root, [npm, '--version'], options)).stdout.trim(),
    );
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

/** Копия позволяет переименовать runtime на Windows, не перемещая работающий node.exe. */
async function installRuntime(source, release) {
  const version = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  const expected = `node-v${version}-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  if (release !== expected) throw new Error('Архив Node.js не подходит для этой системы.');
  const cache = join(root, '.tools');
  await mkdir(cache, { recursive: true });
  await withProjectLock(root, async (lease) => {
    const destination = join(cache, release);
    if (await runtimeReady(destination, version, lease.signal)) return;
    if (!(await runtimeReady(source, version, lease.signal)))
      throw new Error('Загруженные Node.js и npm не запускаются. Повторите загрузку.');
    const staging = await mkdtemp(join(cache, 'runtime-install-'));
    const candidate = join(staging, 'candidate');
    const backup = join(staging, 'previous');
    let movedPrevious = false;
    try {
      await cp(source, candidate, { recursive: true, verbatimSymlinks: true });
      if (!(await runtimeReady(candidate, version, lease.signal)))
        throw new Error('Не удалось подготовить локальный Node.js.');
      await lease.assertOwned();
      try {
        await rename(destination, backup);
        movedPrevious = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await rename(candidate, destination);
      } catch (error) {
        if (movedPrevious) {
          await rename(backup, destination);
          movedPrevious = false;
        }
        throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}

try {
  const [source, release] = process.argv.slice(2);
  if (!source || !release) throw new Error('Не указана папка загруженного Node.js.');
  await installRuntime(resolve(source), release);
} catch (error) {
  console.error('Не удалось подготовить Node.js: ' + error.message);
  process.exitCode = 1;
}
