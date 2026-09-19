import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runPreparationCommand } from './preparation-command.mjs';
import { portableTarget } from './portable-content.mjs';
import { fileHash, extractPortableZip, verifyPortableFiles } from './portable-files.mjs';
import { writeJsonAtomic } from './build-state.mjs';

/** Не наследует облачные ключи и пользовательские подключения; PATH не содержит Node или npm. */
export function portableEnvironment(root, guard) {
  const env = {};
  for (const key of [
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'ComSpec',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'USER',
    'USERNAME',
    'USERDOMAIN',
    'LOGNAME',
    'PATHEXT',
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return {
    ...env,
    PATH: '',
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'localappdata'),
    CODEX_HOME: join(root, 'codex'),
    HARNESS_STATE_DIR: join(root, 'state'),
    NODE_OPTIONS: '--import ' + JSON.stringify(guard),
  };
}

/** PowerShell передаёт буквальный argv в .cmd; ручные кавычки cmd /c не проходят через Node escaping. */
export function windowsLauncher(launcher, args) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot нужен для проверки Windows launcher.');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '[Console]::OutputEncoding = $OutputEncoding',
    '$launcherArgs = @(ConvertFrom-Json -InputObject $env:HARNESS_PORTABLE_ARGS)',
    '& $env:HARNESS_PORTABLE_LAUNCHER @launcherArgs',
    'exit $LASTEXITCODE',
  ].join('\n');
  return {
    executable: win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    env: { HARNESS_PORTABLE_LAUNCHER: launcher, HARNESS_PORTABLE_ARGS: JSON.stringify(args) },
  };
}

/** Проверяет именно распакованный архив: runtime, launchers, native deps и учебный цикл без сети. */
export async function checkPortable(root) {
  const target = portableTarget();
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const prefix = `harness-${version}-${target.platform}-${target.arch}`;
  const releases = join(root, 'releases');
  const reportPath = join(releases, `portable-check-${target.platform}-${target.arch}.json`);
  const logPath = join(releases, `portable-check-${target.platform}-${target.arch}.log`);
  await rm(reportPath, { force: true });
  await writeFile(logPath, 'Проверка готовой поставки ' + prefix + '\n');
  const archive = join(releases, prefix + '.zip');
  const digest = await fileHash(archive);
  assert.equal(
    (await readFile(archive + '.sha256', 'utf8')).trim(),
    digest + '  ' + prefix + '.zip',
  );
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'harness-portable-check-')));
  const unpacked = join(temporary, 'Готовый Harness [проверка] с пробелами');
  let primaryError;
  try {
    await extractPortableZip(archive, prefix, unpacked);
    const expected = { ...target, version };
    const manifest = await verifyPortableFiles(unpacked, expected);
    assert.equal(manifest.nodePlatform, process.platform);
    assert.equal(manifest.node, (await readFile(join(root, '.nvmrc'), 'utf8')).trim());
    const node = join(unpacked, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
    const guard = join(temporary, 'portable-offline.mjs');
    const probe = join(temporary, 'portable-probe.mjs');
    await copyFile(join(root, 'scripts/portable-offline.mjs'), guard);
    await copyFile(join(root, 'scripts/portable-probe.mjs'), probe);
    const home = join(temporary, 'изолированный профиль');
    await mkdir(home);
    const env = portableEnvironment(home, guard);
    const run = async (executable, args, environment = {}) => {
      await appendFile(logPath, '\nЗапуск: ' + JSON.stringify([executable, ...args]) + '\n');
      const result = await runPreparationCommand(temporary, args, {
        executable,
        env: { ...env, ...environment },
        captureOutput: true,
        timeoutMs: 180000,
        allowFailure: true,
      });
      await appendFile(logPath, result.stdout + result.stderr);
      if (result.code !== 0)
        throw new Error(
          'Команда portable-проверки завершилась с кодом ' +
            result.code +
            ': ' +
            result.stderr.trim(),
        );
      return result.stdout.trim();
    };
    assert.equal(await run(node, ['--version']), 'v' + manifest.node);
    const cli = join(unpacked, 'dist/interfaces/cli.js');
    assert.equal(await run(node, [cli, '--version']), version);
    assert.match(await run(node, [cli, '--help']), /Usage: harness/);
    const config = JSON.parse(await run(node, [cli, '--json', 'mcp-config']));
    assert.equal(config.mcp.harness.command[0], node);
    assert.equal(config.mcp.harness.command[1], cli);
    if (process.platform === 'win32') {
      const launcher = windowsLauncher(join(unpacked, 'Запустить Harness.cmd'), ['--version']);
      for (let pass = 0; pass < 2; pass++)
        assert.equal(await run(launcher.executable, launcher.args, launcher.env), version);
    } else {
      for (const launcher of process.platform === 'darwin'
        ? ['start.sh', 'Запустить Harness.command']
        : ['start.sh'])
        for (let pass = 0; pass < 2; pass++)
          assert.equal(await run('/bin/sh', [join(unpacked, launcher), '--version']), version);
    }
    const behavior = JSON.parse(await run(node, [probe, unpacked]));
    await verifyPortableFiles(unpacked, expected);
    const report = {
      status: 'passed',
      version,
      ...target,
      archive: prefix + '.zip',
      archiveSha256: digest,
      files: manifest.files.length,
      systemNodeRequired: false,
      npmRequired: false,
      foreignCwd: true,
      unicodePath: true,
      repeatedLauncher: true,
      cliHelp: true,
      mcpConfig: true,
      filesUnchanged: true,
      ...behavior,
    };
    await writeJsonAtomic(reportPath, report);
    return report;
  } catch (error) {
    primaryError = error;
    await appendFile(logPath, '\nОшибка: ' + (error.stack ?? error.message) + '\n');
    throw error;
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (primaryError) console.error(error);
      else throw error;
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2)
      throw new Error('Параметры не нужны: проверяется ZIP текущей системы.');
    console.log(
      JSON.stringify(
        await checkPortable(resolve(dirname(fileURLToPath(import.meta.url)), '..')),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error('Проверка portable-поставки не пройдена: ' + error.message);
    process.exitCode = 1;
  }
}
