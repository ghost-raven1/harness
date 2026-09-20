import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../application/bootstrap.js';
import { ProviderRouter } from '../providers/router.js';
import type { PermissionRule } from '../configuration/schema.js';
import { BenchmarkProvider, BenchmarkRoutingProvider } from './provider.js';
import { verificationSource } from './verification.js';
import type { BenchmarkMode, BenchmarkScenario, BenchmarkSelection } from './types.js';

export const benchmarkLimits = {
  agents: 4,
  depth: 2,
  modelConcurrency: 2,
  turns: 64,
  trialTimeoutMs: 180000,
};
export const benchmarkRoles = ['coordinator', 'executor', 'researcher', 'reviewer'];

/** Создаёт новую папку и закрепляет одну и ту же команду стенда, независимо от пользовательских ролей. */
export async function createBenchmarkSession(
  root: string,
  scenario: BenchmarkScenario,
  mode: BenchmarkMode,
  selection: BenchmarkSelection,
) {
  const workspace = join(root, 'workspace');
  const directory = join(root, 'state');
  const config = join(root, 'config');
  await mkdir(root);
  await mkdir(workspace);
  await mkdir(config);
  await writeFile(join(workspace, 'package.json'), '{"private":true,"type":"module"}');
  for (const [path, content] of Object.entries(scenario.files))
    await writeFile(join(workspace, path), content);
  const checker = join(root, 'verify.mjs');
  await writeFile(checker, verificationSource(scenario));
  const args = ['--experimental-vm-modules', checker, workspace];
  const readable: PermissionRule[] = ['fs.read', 'fs.list', 'fs.search', 'artifacts.read'].map(
    (tool) => ({ tool, decision: 'allow', args: {} }),
  );
  const writable = [
    ...new Set([
      ...scenario.parts.flatMap((part) => Object.keys(part.writes)),
      ...Object.keys(scenario.finalWrites),
    ]),
  ];
  const permissions: PermissionRule[] = [
    ...readable,
    ...writable.map(
      (path): PermissionRule => ({ tool: 'fs.write', decision: 'allow', args: { path } }),
    ),
    { tool: 'process.exec', decision: 'allow', args: {} },
    ...['agents.delegate', 'agents.handoff', 'agents.await'].map(
      (tool): PermissionRule => ({
        tool,
        decision: mode === 'solo' && tool !== 'agents.await' ? 'deny' : 'allow',
        args: {},
      }),
    ),
  ];
  const prompts: Record<string, string> = {
    coordinator:
      'Координируй задачу, объединяй результаты. Независимые части можно делегировать; общие записи и зависимые изменения нужно согласовать.',
    executor:
      'Изучай исходники и вноси необходимые изменения в назначенные файлы. Не меняй ожидания доверенных проверок.',
    researcher:
      'Читай назначенные источники и возвращай проверяемые факты с именами файлов. Файлы не изменяй.',
    reviewer: 'Проверяй согласованность результата по исходникам. Файлы не изменяй.',
  };
  const roles = Object.fromEntries(
    benchmarkRoles.map((role) => [
      role,
      {
        prompt: role + '.md',
        permissions: ['researcher', 'reviewer'].includes(role) ? readable : permissions,
      },
    ]),
  );
  const files: Record<string, unknown> = {
    'rules.json': [
      'Это сравнительный стенд. Доступна только выбранная учебная папка; пользовательские проекты и настройки не используются.',
      'Используй относительные пути. Критерии проверки неизменны.',
    ],
    'policy.json': { default: 'deny', rules: permissions },
    'roles.json': roles,
    'profiles.json': { benchmark: selection.profile },
    'tools.json': { timeoutMs: 15000, mcp: [] },
    'learning.json': { enabled: false, cases: [] },
    'harness.json': {
      schemaVersion: 1,
      basePrompt: 'base.md',
      rules: 'rules.json',
      policy: 'policy.json',
      roles: 'roles.json',
      profiles: 'profiles.json',
      tools: 'tools.json',
      learning: 'learning.json',
      defaultRole: 'coordinator',
      defaultProfile: 'benchmark',
      coordination: mode === 'solo' ? 'manual' : 'auto',
      workspaces: [workspace],
      limits: { agents: 4, depth: 2, modelConcurrency: 2, turns: 64, reads: 4, handoffs: 8 },
    },
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(join(config, name), JSON.stringify(value, null, 2));
  for (const [role, prompt] of Object.entries(prompts))
    await writeFile(join(config, role + '.md'), prompt);
  await writeFile(
    join(config, 'base.md'),
    'Выполни задачу разработки. Успех определяет доверенная проверка файлов. Доступная команда проверки: ' +
      JSON.stringify([process.execPath, ...args]),
  );
  const provider =
    selection.kind === 'offline'
      ? new BenchmarkProvider(scenario)
      : new ProviderRouter(benchmarkLimits.modelConcurrency);
  const app = await createApplication(
    join(config, 'harness.json'),
    directory,
    new BenchmarkRoutingProvider(provider, scenario, mode),
  );
  const executable = app.registry.get('process.exec');
  const execute = executable.execute.bind(executable);
  executable.execute = async (input, context) => {
    if (input.command !== process.execPath || JSON.stringify(input.args) !== JSON.stringify(args))
      throw new Error('Стенд разрешает только закреплённую команду доверенной проверки.');
    return execute(input, context);
  };
  return { app, workspace, directory, command: process.execPath, args };
}
