import { execFile } from 'node:child_process';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const repository = resolve('.');

/** Запускает настоящий скрипт в отдельном дереве пакетов, не меняя зависимости проекта. */
async function fixture(options: { installed?: string; engine?: string; nested?: boolean } = {}) {
  const root = await temporary();
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'node_modules'));
  await cp(join(repository, 'scripts/check-engines.mjs'), join(root, 'scripts/check-engines.mjs'));
  // Ссылка нужна только импорту semver; обход проверяемых пакетов её пропускает.
  await symlink(
    join(repository, 'node_modules/semver'),
    join(root, 'node_modules/semver'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const node = process.version.slice(1);
  await writeFile(join(root, '.nvmrc'), node + '\n');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'engine-fixture', type: 'module', engines: { node } }),
  );
  const packages: Record<string, { version: string }> = {};
  const location = options.nested
    ? 'node_modules/parent-library/node_modules/test-library'
    : 'node_modules/test-library';
  if (options.nested) {
    await mkdir(join(root, 'node_modules/parent-library'), { recursive: true });
    await writeFile(
      join(root, 'node_modules/parent-library/package.json'),
      JSON.stringify({ name: 'parent-library', version: '2.0.0' }),
    );
    packages['node_modules/parent-library'] = { version: '2.0.0' };
  }
  await mkdir(join(root, location), { recursive: true });
  await writeFile(
    join(root, location, 'package.json'),
    JSON.stringify({
      name: 'test-library',
      version: options.installed ?? '1.0.0',
      engines: { node: options.engine ?? node },
    }),
  );
  packages[location] = { version: '1.0.0' };
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return () =>
    execute(process.execPath, [join(root, 'scripts/check-engines.mjs')], {
      cwd: root,
      timeout: 5000,
    });
}

test('проверка принимает установленную версию из lockfile и совместимый Node.js', async () => {
  const check = await fixture();
  const result = await check();
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(
    'All installed dependency engine ranges accept ' + process.version,
  );
});

test.each([false, true])(
  'несовпадение версии останавливает проверку, вложенный пакет: %s',
  async (nested) => {
    const check = await fixture({ installed: '1.0.1', nested });
    await expect(check()).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining('test-library: lockfile 1.0.0, installed 1.0.1'),
    });
  },
);

test('совпавшая версия не скрывает несовместимые требования пакета к Node.js', async () => {
  const check = await fixture({ engine: '<1' });
  await expect(check()).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: expect.stringContaining('test-library@1.0.0: <1'),
  });
});
