import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

const checkScript = pathToFileURL(resolve('scripts/release-smoke.mjs')).href;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Повреждённая поставка отбрасывается до установки и не оставляет прежний зелёный отчёт. */
it.each([
  ['checksum', 'Контрольная сумма ZIP'],
  ['path', 'Некорректный путь'],
  ['extra', 'отсутствующие в манифесте'],
  ['duplicate', 'повторный файл'],
  ['missing', 'Повреждённый'],
  ['name', 'Манифест поставки'],
])('отвергает некорректную поставку: %s', async (kind, message) => {
  const root = await temporary();
  const releases = join(root, 'releases');
  await mkdir(releases);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'modular-agent-harness', version: '0.1.0' }),
  );
  const prefix = 'harness-0.1.0-source';
  const content = Buffer.from('Проверочный файл');
  const file = {
    path: kind === 'path' ? '../escaped.txt' : 'README.md',
    sha256: sha256(content),
    mode: 0o644,
  };
  const manifest = {
    schemaVersion: 1,
    name: kind === 'name' ? 'another-project' : 'modular-agent-harness',
    version: '0.1.0',
    files: kind === 'duplicate' ? [file, file] : [file],
  };
  const entries: Record<string, Uint8Array> = {
    [prefix + '/release-manifest.json']: Buffer.from(JSON.stringify(manifest)),
  };
  if (kind !== 'missing') entries[prefix + '/' + file.path] = content;
  if (kind === 'extra') entries[prefix + '/.env.production'] = Buffer.from('SYNTHETIC_ONLY=1');
  const archive = zipSync(entries);
  const archiveName = prefix + '.zip';
  await writeFile(join(releases, archiveName), archive);
  await writeFile(
    join(releases, archiveName + '.sha256'),
    (kind === 'checksum' ? '0'.repeat(64) : sha256(archive)) + '  ' + archiveName + '\n',
  );
  await writeFile(join(releases, 'release-check.json'), '{"status":"passed"}');
  const { checkRelease } = await import(checkScript);
  await expect(checkRelease(root)).rejects.toThrow(message);
  await expect(stat(join(releases, 'release-check.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
