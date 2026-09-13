import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const manifestName = 'build-manifest.json';
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Обход не зависит от локали и отвергает ссылки в публикуемой сборке. */
export async function inventory(directory) {
  const result = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        result.push({
          path: relative(directory, path).replaceAll('\\', '/'),
          hash: digest(await readFile(path)),
        });
      else throw new Error('Неподдерживаемый файл сборки: ' + path);
    }
  }
  await visit(directory);
  return result;
}

/** Отпечатки учитывают конфиги компилятора, код подготовки и платформу зависимостей. */
export async function buildInputs(root) {
  async function hashFiles(names) {
    const values = [];
    for (const name of names) values.push([name, digest(await readFile(join(root, name)))]);
    return values;
  }
  const dependencies = digest(
    JSON.stringify([
      process.version,
      process.platform,
      process.arch,
      await hashFiles(['package.json', 'package-lock.json', '.npmrc', '.nvmrc']),
    ]),
  );
  const sources = digest(
    JSON.stringify([
      await inventory(join(root, 'src')),
      await hashFiles([
        'tsconfig.json',
        'tsconfig.build.json',
        'scripts/build.mjs',
        'scripts/build-state.mjs',
        'scripts/project-lock.mjs',
        'scripts/preparation-command.mjs',
        'scripts/bootstrap.mjs',
      ]),
    ]),
  );
  return { dependencies, sources };
}

/** Проверяет каждый выходной файл и отсутствие оставшихся от прежней сборки модулей. */
export async function validBuild(root, inputs, directory = join(root, 'dist')) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, manifestName), 'utf8'));
    if (
      manifest?.schemaVersion !== 1 ||
      (inputs &&
        (manifest.dependencies !== inputs.dependencies || manifest.sources !== inputs.sources))
    )
      return false;
    const actual = (await inventory(directory)).filter((file) => file.path !== manifestName);
    return (
      actual.some((file) => file.path === 'interfaces/cli.js') &&
      JSON.stringify(actual) === JSON.stringify(manifest.files)
    );
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Не оставляет частично записанный маркер после прерванной подготовки. */
export async function writeJsonAtomic(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
