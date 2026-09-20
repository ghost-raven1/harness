import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { scenarios } from '../src/benchmark/scenarios.js';
import { createBenchmarkSession } from '../src/benchmark/session.js';
import { offlineSelection } from '../src/benchmark/runner.js';
import { executeProgram } from '../src/tools/process.js';
import { temporary } from './helpers.js';

/** Запускает именно закреплённую проверочную команду над изменёнными учебными исходниками. */
async function verify(scenarioId: string, changes: Record<string, string>) {
  const root = await temporary();
  const scenario = scenarios.find((item) => item.id === scenarioId)!;
  const session = await createBenchmarkSession(
    join(root, 'trial'),
    scenario,
    'solo',
    offlineSelection(),
  );
  try {
    for (const [path, source] of Object.entries(changes))
      await writeFile(join(session.workspace, path), source);
    return await executeProgram(session.command, session.args, {
      workspace: session.workspace,
      signal: AbortSignal.timeout(10000),
    });
  } finally {
    await session.app.close();
  }
}

test('изменённый модуль не может подделать stdout и завершить доверенный проверяющий процесс', async () => {
  const result = await verify('independent', {
    'square.js': [
      'process.stdout.write(JSON.stringify({checks:[{passed:true},{passed:true}]}));',
      'process.exit(0);',
      'export const square=x=>0;',
    ].join('\n'),
  });
  expect(result.exitCode).not.toBe(0);
});

test('исправление теста не принимается, если assert.equal остался только в комментарии', async () => {
  const result = await verify('test-repair', { 'add.test.js': '// assert.equal(add(2,2),4)\n' });
  expect(result.exitCode).not.toBe(0);
});

test('изменённый модуль не подменяет assert доверенных проверок', async () => {
  const result = await verify('independent', {
    'square.js':
      'import assert from "node:assert/strict"; assert.equal=()=>{}; export const square=x=>0;\n',
  });
  expect(result.exitCode).not.toBe(0);
});

test.each([
  ['JSON', '{stringify:()=>\'[ {"passed":true}, {"passed":true} ]\'}'],
  ['Object', '{...Object,is:()=>true}'],
])('изменённый модуль не заменяет глобальный %s доверенных проверок', async (name, value) => {
  const result = await verify('independent', {
    'square.js': `globalThis.${name}=${value}; export const square=x=>0;\n`,
  });
  expect(result.exitCode).not.toBe(0);
});

test.each(['independent', 'test-repair'])(
  'настоящее исправление %s проходит неизменные критерии',
  async (scenarioId) => {
    const scenario = scenarios.find((item) => item.id === scenarioId)!;
    const writes = Object.assign(
      {},
      ...scenario.parts.map((part) => part.writes),
      scenario.finalWrites,
    ) as Record<string, string>;
    const result = await verify(scenarioId, writes);
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { checks: Array<{ passed: boolean }> };
    expect(output.checks).toHaveLength(scenario.checks.length);
    expect(output.checks.every((check) => check.passed)).toBe(true);
  },
);
