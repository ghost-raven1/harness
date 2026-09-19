import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { runPreparationCommand } from './preparation-command.mjs';
import { writeJsonAtomic } from './build-state.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Проверяет поставку после распаковки: установка, повторный запуск, CLI и при необходимости весь check. */
export async function checkRelease(root, { full = false } = {}) {
  await rm(join(root, 'releases/release-check.json'), { force: true });
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const prefix = `harness-${pkg.version}-source`;
  const releases = join(root, 'releases');
  const archiveName = prefix + '.zip';
  const archive = await readFile(join(releases, archiveName));
  const checksum = (await readFile(join(releases, archiveName + '.sha256'), 'utf8')).trim();
  if (checksum !== digest(archive) + '  ' + archiveName)
    throw new Error('Контрольная сумма ZIP не совпадает. Повторите release:pack.');
  const entries = unzipSync(archive);
  const manifestName = prefix + '/release-manifest.json';
  if (!entries[manifestName]) throw new Error('В поставке нет манифеста файлов.');
  const manifest = JSON.parse(Buffer.from(entries[manifestName]).toString('utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== pkg.name ||
    manifest.version !== pkg.version ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Манифест поставки не соответствует версии проекта.');
  const expected = new Set([manifestName]);
  for (const file of manifest.files) {
    const name = prefix + '/' + file.path;
    if (expected.has(name) || !entries[name] || digest(entries[name]) !== file.sha256)
      throw new Error('Повреждённый или повторный файл поставки: ' + file.path);
    expected.add(name);
  }
  if (Object.keys(entries).length !== expected.size)
    throw new Error('В ZIP есть файлы, отсутствующие в манифесте.');
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'harness-release-')));
  const project = join(temporary, 'Поставка [проверка] с пробелами');
  const state = join(temporary, 'отдельное состояние');
  const log = await open(join(releases, 'release-check.log'), 'w', 0o600);
  let report, primaryError;
  try {
    for (const file of manifest.files) {
      if (
        typeof file.path !== 'string' ||
        file.path.includes('\\') ||
        file.path.includes(':') ||
        posix.isAbsolute(file.path) ||
        posix.normalize(file.path) !== file.path ||
        file.path.split('/').includes('..') ||
        ![0o644, 0o755].includes(file.mode)
      )
        throw new Error('Некорректный путь или режим файла поставки.');
      const target = join(project, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entries[prefix + '/' + file.path]);
      await chmod(target, file.mode);
    }
    const environment = {
      ...process.env,
      PATH:
        dirname(process.execPath) +
        (process.platform === 'win32' ? ';' : ':') +
        (process.env.PATH ?? ''),
      HARNESS_STATE_DIR: state,
    };
    const run = (args, captureOutput = false) =>
      runPreparationCommand(temporary, args, {
        env: environment,
        captureOutput,
        stdio: ['ignore', log.fd, log.fd],
        timeoutMs: 15 * 60_000,
      });
    const bootstrap = join(project, 'scripts/bootstrap.mjs');
    console.log('Проверяю установку распакованного выпуска ' + pkg.version + '…');
    await run([bootstrap, '--prepare-only']);
    const cli = join(project, 'dist/interfaces/cli.js');
    const before = (await stat(cli)).mtimeMs;
    await run([bootstrap, '--prepare-only']);
    if ((await stat(cli)).mtimeMs !== before)
      throw new Error('Повторная подготовка пересобрала исправный кэш.');
    const version = (await run([cli, '--version'], true)).stdout.trim();
    if (version !== pkg.version) throw new Error('Версия CLI отличается от версии поставки.');
    const help = (await run([cli, '--help'], true)).stdout;
    if (!help.includes('Usage: harness')) throw new Error('Не открылась справка CLI.');
    const config = JSON.parse(
      (await run([cli, '--state', state, '--json', 'mcp-config'], true)).stdout,
    );
    if (config.mcp?.harness?.command?.[1] !== cli)
      throw new Error('MCP-конфигурация ссылается на другую установку.');
    if (full) {
      console.log('Проверяю форматирование, типы и все тесты внутри распакованного выпуска…');
      const npm = join(
        dirname(process.execPath),
        process.platform === 'win32'
          ? 'node_modules/npm/bin/npm-cli.js'
          : '../lib/node_modules/npm/bin/npm-cli.js',
      );
      await runPreparationCommand(project, [npm, 'run', 'check'], {
        env: environment,
        stdio: ['ignore', log.fd, log.fd],
        timeoutMs: 15 * 60_000,
      });
    }
    report = {
      status: 'passed',
      checkedAt: new Date().toISOString(),
      version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      archive: archiveName,
      archiveSha256: digest(archive),
      files: manifest.files.length,
      freshInstall: true,
      repeatedBuildUnchanged: true,
      foreignCwd: true,
      cliHelp: true,
      mcpConfig: true,
      fullCheck: full,
      cloudRequests: false,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      async () => {
        try {
          await copyFile(join(project, '.tools/setup.log'), join(releases, 'release-install.log'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      },
      () => log.close(),
      () => rm(temporary, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const error = new AggregateError(cleanupErrors, 'Не удалось очистить проверку поставки.');
      // Исходная ошибка установки важнее вторичного отказа удаления временной папки.
      if (primaryError) console.error(error);
      else throw error;
    }
  }
  await writeJsonAtomic(join(releases, 'release-check.json'), report);
  console.log('Выпуск проверен. Отчёт: ' + join(releases, 'release-check.json'));
  return report;
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--full'))
      throw new Error('Допустимый параметр: --full.');
    await checkRelease(resolve(dirname(fileURLToPath(import.meta.url)), '..'), {
      full: process.argv.includes('--full'),
    });
  } catch (error) {
    console.error('Проверка выпуска не прошла: ' + error.message);
    process.exitCode = 1;
  }
}
