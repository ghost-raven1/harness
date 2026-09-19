import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoSource } from '../providers/demo-provider.js';
import type { ToolRegistry } from '../tools/registry.js';

/** Создаёт полностью отдельные код, конфигурацию и состояние учебного запуска. */
export async function createDemoFiles() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-demo-')));
  const workspace = join(root, 'workspace');
  const directory = join(root, 'state');
  const config = join(root, 'config');
  try {
    await mkdir(workspace);
    await mkdir(config);
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    await writeFile(join(workspace, 'price.js'), demoSource);
    await writeFile(
      join(workspace, 'price.test.js'),
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { total } from './price.js';",
        "test('Стоимость 120 × 3 равна 360', () => assert.equal(total(120, 3), 360));",
        '',
      ].join('\n'),
    );
    const permissions = [
      { tool: 'fs.read', decision: 'allow' },
      { tool: 'fs.write', decision: 'allow', args: { path: 'price.js' } },
      { tool: 'process.exec', decision: 'allow' },
    ];
    const files: Record<string, unknown> = {
      'rules.json': ['Учебный режим. Разрешён только фиксированный сценарий расчёта стоимости.'],
      'policy.json': { default: 'deny', rules: permissions },
      'roles.json': { coordinator: { prompt: 'role.md', permissions } },
      'profiles.json': {
        demo: {
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1/v1',
          model: 'Учебный сценарий',
          contextTokens: 65536,
          outputTokens: 4096,
          retries: 0,
        },
      },
      'tools.json': { timeoutMs: 10000, mcp: [] },
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
        defaultProfile: 'demo',
        coordination: 'manual',
        workspaces: [workspace],
        limits: { turns: 32 },
      },
    };
    for (const [name, value] of Object.entries(files))
      await writeFile(join(config, name), JSON.stringify(value, null, 2));
    await writeFile(
      join(config, 'base.md'),
      'Учебный провайдер. Доказательством результата служат реальные тесты.',
    );
    await writeFile(
      join(config, 'role.md'),
      'Исправляй только price.js. Критерии теста остаются неизменными.',
    );
    return { root, workspace, directory, configFile: join(config, 'harness.json') };
  } catch (error) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    );
    throw error;
  }
}

/** Ограничивает обычный исполнитель точным argv; редактирование плана не открывает другие команды. */
export function restrictDemoCommands(registry: ToolRegistry): void {
  const tool = registry.get('process.exec');
  const execute = tool.execute.bind(tool);
  tool.execute = async (args, context) => {
    if (
      args.command !== process.execPath ||
      JSON.stringify(args.args) !== JSON.stringify(['--test', 'price.test.js'])
    )
      throw new Error('В учебном режиме доступна только проверка price.test.js через Node.js.');
    return execute(args, context);
  };
}
