import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const repository = resolve('.');
const cli = join(repository, 'dist/interfaces/cli.js');
let workspace: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'harness cli ')));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Реальный Node запускает CLI из чужой папки, как это делает установленная команда. */
async function invoke(entry: string, args: string[]) {
  return execute(process.execPath, [entry, ...args], { cwd: workspace, timeout: 10000 });
}

async function versionAndHelp(entry: string) {
  const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  const version = await invoke(entry, ['--version']);
  expect(version.stdout.trim()).toBe(manifest.version);
  expect(version.stderr).toBe('');
  const help = await invoke(entry, ['--help']);
  expect(help.stdout).toContain('Usage: harness');
  expect(help.stdout).toContain('mcp-config');
  expect(help.stderr).toBe('');
}

it('прямой запуск показывает версию и справку из чужой рабочей папки', async () => {
  await versionAndHelp(cli);
});

// npm создаёт ссылки bin на POSIX; Windows использует отдельную командную обёртку.
it.skipIf(process.platform === 'win32')(
  'npm-ссылка запускает CLI и сохраняет аргументы',
  async () => {
    const linked = join(workspace, 'harness');
    await symlink(cli, linked);
    await versionAndHelp(linked);
    const state = join(workspace, 'данные проекта');
    const output = await invoke(linked, ['--state', state, '--json', 'mcp-config']);
    const config = JSON.parse(output.stdout);
    expect(config.mcp.harness.command).toEqual([process.execPath, cli, '--state', state, 'mcp']);
    expect(output.stderr).toBe('');
  },
);

it('прямой запуск сохраняет аргументы с пробелами и относительный путь состояния', async () => {
  const output = await invoke(cli, ['--state', 'мои данные', '--json', 'mcp-config']);
  const config = JSON.parse(output.stdout);
  expect(config.mcp.harness.command).toEqual([
    process.execPath,
    cli,
    '--state',
    join(workspace, 'мои данные'),
    'mcp',
  ]);
  expect(output.stderr).toBe('');
});

it('импорт createCli не запускает разбор аргументов вызывающей программы', async () => {
  const importer = join(workspace, 'import-cli.mjs');
  await writeFile(
    importer,
    `process.argv = [process.execPath, ${JSON.stringify(cli)}, '--version'];
const {createCli} = await import(${JSON.stringify(pathToFileURL(cli).href)});
console.log('IMPORTED:' + typeof createCli);\n`,
  );
  const output = await invoke(importer, []);
  expect(output.stdout).toBe('IMPORTED:function\n');
  expect(output.stderr).toBe('');
});
