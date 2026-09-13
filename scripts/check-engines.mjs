import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
const failures = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const location = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await inspect(location);
      continue;
    }
    const pkg = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
    if (pkg.engines?.node && !semver.satisfies(process.version, pkg.engines.node)) {
      failures.push(`${pkg.name}@${pkg.version}: ${pkg.engines.node}`);
    }
    try {
      await inspect(join(location, 'node_modules'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
const expected = (await readFile('.nvmrc', 'utf8')).trim();
const project = JSON.parse(await readFile('package.json', 'utf8'));
if (!semver.valid(expected) || !semver.satisfies(expected, project.engines.node))
  throw new Error('Версия .nvmrc не согласована с engines.node в package.json');
if (process.version !== 'v' + expected)
  throw new Error(`Expected Node v${expected}, got ${process.version}`);
await inspect('node_modules');
if (failures.length) throw new Error(failures.join('\n'));
console.log(`All installed dependency engine ranges accept ${process.version}`);
