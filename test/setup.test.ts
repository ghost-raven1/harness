import { it, expect } from 'vitest';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary } from './helpers.js';
import { modelServer, command, startDaemon, cli, alias } from './process-fixture.js';
import { findConfig } from '../src/configuration/discovery.js';

it('первый запуск из подпапки: init → offline doctor → serve → stdin → status', async () => {
  const root = await temporary();
  const workspace = join(root, 'новый проект');
  const nested = join(workspace, 'src', 'feature');
  const directory = join(root, 'state');
  await mkdir(nested, { recursive: true });
  const api = await modelServer((body) =>
    body.tools?.[0]?.function.description.startsWith('agents.plan:')
      ? {
          calls: [
            {
              id: 'initial-plan',
              name: alias(body, 'agents.plan'),
              args: {
                mode: 'direct',
                reason: 'Небольшую задачу выполняет текущая роль.',
                tasks: [],
              },
            },
          ],
        }
      : { text: 'Задача из stdin выполнена' },
  );
  const initialized = await command([
    '--json',
    '--state',
    directory,
    'init',
    '--workspace',
    workspace,
    '--provider',
    'openai-compatible',
    '--model',
    'local',
    '--base-url',
    api.baseUrl,
    '--no-api-key',
  ]);
  expect(initialized.code).toBe(0);
  const file = JSON.parse(initialized.stdout).config as string;
  expect(findConfig(nested)).toBe(file);
  const doctor = await command(['--state', directory, '--json', 'doctor'], {}, { cwd: nested });
  expect(doctor.code).toBe(1);
  const diagnostic = JSON.parse(doctor.stdout);
  expect(diagnostic.ready).toBe(false);
  expect(diagnostic.checks).toContainEqual(
    expect.objectContaining({ name: 'Конфигурация', status: 'pass' }),
  );
  await startDaemon(undefined, directory, nested);
  const result = await command(
    ['--state', directory, '--json', 'run', '--stdin', '--workspace', workspace],
    {},
    { input: 'Прочитай задачу из стандартного ввода\n', cwd: nested },
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('Задача из stdin выполнена');
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(records.at(-1).status).toBe('completed');
  expect(JSON.stringify(api.bodies)).toContain('Прочитай задачу');
  expect(api.bodies[0]?.tools?.[0]?.function.description).toMatch(/^agents\.plan:/);
  const online = await command(['--state', directory, '--json', 'doctor'], {}, { cwd: nested });
  expect(online.code).toBe(0);
  expect(JSON.parse(online.stdout).ready).toBe(true);
});

it('повторный init не перезаписывает авторские файлы', async () => {
  const root = await temporary();
  const directory = join(root, 'config');
  const args = [
    '--json',
    'init',
    directory,
    '--workspace',
    root,
    '--provider',
    'openai-compatible',
    '--no-api-key',
  ];
  expect((await command(args)).code).toBe(0);
  const before = await readFile(join(directory, 'harness.json'), 'utf8');
  const repeated = await command(args);
  expect(repeated.code).toBe(1);
  expect(repeated.stdout).toContain('уже существует');
  expect(await readFile(join(directory, 'harness.json'), 'utf8')).toBe(before);
});

it('mcp-config содержит фактический Node, CLI и каталог состояния без ручного экранирования', async () => {
  const directory = join(await temporary(), 'состояние с пробелами');
  const result = await command(['--state', directory, 'mcp-config']);
  expect(result.code).toBe(0);
  const config = JSON.parse(result.stdout);
  expect(config.mcp.harness.command).toEqual([process.execPath, cli, '--state', directory, 'mcp']);
});

it('пустой stdin возвращает понятную ошибку вместо зависания', async () => {
  const result = await command(['--json', 'run', '--stdin'], {}, { input: '' });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toBe(
    'Задача должна содержать от 1 до 100 000 символов и не состоять из пробелов.',
  );
});
