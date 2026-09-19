import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildInputs, validBuild } from './build-state.mjs';
import { withProjectLock } from './project-lock.mjs';
import { runPreparationCommand } from './preparation-command.mjs';
import { portableInventory, writePortableZip, fileHash } from './portable-files.mjs';
import {
  portableTarget,
  copyPortableTree,
  copyRuntime,
  writeLaunchers,
  writeNotices,
} from './portable-content.mjs';

/** Собирает нативный ZIP в отдельной папке: установка npm выполняется только на машине сборки. */
export async function packPortable(root) {
  const target = portableTarget();
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const node = (await readFile(join(root, '.nvmrc'), 'utf8')).trim();
  if (process.version !== 'v' + node) throw new Error('Поставку нужно собирать на Node.js ' + node);
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(pkg.version) || pkg.version !== lock.version)
    throw new Error('Версия package.json и lockfile не согласована.');
  const prefix = `harness-${pkg.version}-${target.platform}-${target.arch}`;
  const output = join(root, 'releases');
  await mkdir(output, { recursive: true });
  const logPath = join(output, `portable-pack-${target.platform}-${target.arch}.log`);
  const log = await open(logPath, 'w', 0o600);
  const archive = join(output, '.' + prefix + '-' + randomUUID() + '.tmp');
  let temporary, primaryError;
  try {
    temporary = await mkdtemp(join(tmpdir(), 'harness-portable-pack-'));
    return await withProjectLock(root, async (lease) => {
      const inputs = await buildInputs(root);
      if (!(await validBuild(root, inputs)))
        throw new Error('Перед portable:pack выполните npm run build.');
      const install = join(temporary, 'production');
      const stage = join(temporary, prefix);
      await mkdir(install);
      await mkdir(stage);
      for (const name of ['package.json', 'package-lock.json', '.npmrc'])
        await writeFile(join(install, name), await readFile(join(root, name)));
      const npm =
        process.platform === 'win32'
          ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
          : join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
      console.error('Устанавливаю production-зависимости в отдельную папку сборки…');
      const options = {
        signal: lease.signal,
        timeoutMs: 15 * 60_000,
        stdio: ['ignore', log.fd, log.fd],
        env: {
          ...process.env,
          PATH:
            dirname(process.execPath) +
            (process.platform === 'win32' ? ';' : ':') +
            (process.env.PATH ?? ''),
        },
      };
      await runPreparationCommand(
        install,
        [npm, 'ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund'],
        options,
      );
      await runPreparationCommand(
        install,
        [npm, 'ls', '--all', '--omit=dev', '--include=optional'],
        options,
      );
      await copyPortableTree(join(install, 'node_modules'), join(stage, 'node_modules'), true);
      await copyPortableTree(join(root, 'dist'), join(stage, 'dist'));
      await copyPortableTree(join(root, 'config'), join(stage, 'config'));
      for (const name of ['package.json', 'package-lock.json', '.nvmrc'])
        await writeFile(join(stage, name), await readFile(join(root, name)));
      await copyRuntime(stage);
      await writeLaunchers(stage, pkg.version, target);
      await writeNotices(stage, lock);
      const manifest = {
        schemaVersion: 1,
        version: pkg.version,
        ...target,
        node,
        sources: inputs.sources,
        dependencies: inputs.dependencies,
        files: await portableInventory(stage),
      };
      await writeFile(
        join(stage, 'portable-manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
      );
      const files = [
        ...manifest.files,
        {
          path: 'portable-manifest.json',
          mode: 0o644,
        },
      ];
      console.error('Сохраняю готовый ZIP с runtime и встроенными компонентами…');
      await writePortableZip(stage, prefix, files, archive);
      const sha256 = await fileHash(archive);
      await writeFile(archive + '.sha256', sha256 + '  ' + prefix + '.zip\n');
      await lease.assertOwned();
      if (JSON.stringify(inputs) !== JSON.stringify(await buildInputs(root)))
        throw new Error('Исходники изменились во время подготовки portable-поставки.');
      const published = join(output, prefix + '.zip');
      await rename(archive, published);
      await rename(archive + '.sha256', published + '.sha256');
      return { archive: published, sha256, files: files.length, ...target, node, log: logPath };
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const failures = [];
    for (const cleanup of [
      () => log.close(),
      () => rm(archive, { force: true }),
      () => rm(archive + '.sha256', { force: true }),
      () =>
        temporary &&
        rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      const error = new AggregateError(failures, 'Не удалось полностью очистить portable-сборку.');
      // Отказ удаления на Windows не скрывает первичную ошибку npm, записи или проверки.
      if (primaryError) console.error(error);
      else throw error;
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Параметры не нужны: сборка выполняется для текущей системы.');
    console.log(
      JSON.stringify(
        await packPortable(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error('Portable-поставка не собрана: ' + error.message);
    process.exitCode = 1;
  }
}
