import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Zip, ZipDeflate, Unzip, UnzipInflate } from 'fflate';

/** Хеширует большой исполняемый файл, не помещая его целиком в память. */
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Собирает обычные файлы; ссылки и специальные устройства в поставку не попадают. */
export async function portableInventory(root, relative = '') {
  const directory = join(root, relative);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Некорректный каталог поставки.');
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    const absolute = join(root, path);
    if (entry.isDirectory()) result.push(...(await portableInventory(root, path)));
    else if (entry.isFile()) {
      const info = await lstat(absolute);
      result.push({
        path,
        bytes: info.size,
        mode: info.mode & 0o111 ? 0o755 : 0o644,
        sha256: await fileHash(absolute),
      });
    } else throw new Error('Ссылка или специальный файл запрещён: ' + path);
  }
  return result;
}

/** Пишет ZIP частями и сохраняет исполняемые биты; память не зависит от размера Codex. */
export async function writePortableZip(root, prefix, files, destination) {
  const handle = await open(destination, 'wx', 0o644);
  let pending = Promise.resolve();
  let failure;
  const zip = new Zip((error, bytes) => {
    if (error) {
      failure = error;
      return;
    }
    pending = pending.then(async () => {
      let offset = 0;
      while (offset < bytes.length)
        offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
    });
    // Отказ диска должен передаться владельцу без необработанного rejection между чанками.
    pending.catch(() => undefined);
  });
  try {
    for (const file of files) {
      const entry = new ZipDeflate(prefix + '/' + file.path, { level: 6 });
      entry.mtime = new Date(1980, 0, 1, 0, 0, 0);
      entry.os = 3;
      entry.attrs = ((0o100000 | file.mode) << 16) >>> 0;
      zip.add(entry);
      for await (const bytes of createReadStream(join(root, file.path))) {
        entry.push(bytes);
        await pending;
        if (failure) throw failure;
      }
      entry.push(new Uint8Array(), true);
      await pending;
    }
    zip.end();
    await pending;
    if (failure) throw failure;
    await handle.sync();
  } finally {
    zip.terminate();
    await pending.catch(() => undefined);
    await handle.close();
  }
}

/** Отвергает неоднозначные пути ZIP до создания файла. */
export function archivePath(name, prefix) {
  if (!name.startsWith(prefix + '/')) throw new Error('ZIP содержит чужой корневой каталог.');
  const path = name.slice(prefix.length + 1);
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.includes('\0') ||
    /[\x01-\x1f]/.test(path) ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Небезопасный путь ZIP: ' + name);
  return path;
}

/** Распаковывает поток с пределами размера и числа файлов в новый пустой каталог. */
export async function extractPortableZip(archive, prefix, destination) {
  await mkdir(destination);
  const names = new Set();
  const handles = new Set();
  let pending = Promise.resolve();
  let failure;
  let total = 0;
  const enqueue = (work) => {
    pending = pending.then(work);
    pending.catch(() => undefined);
  };
  const close = async (handle) => {
    if (handles.delete(handle)) await handle.close();
  };
  const unzip = new Unzip((entry) => {
    let path;
    try {
      path = archivePath(entry.name, prefix);
      const key = path.toLocaleLowerCase('en-US');
      if (names.has(key) || names.size >= 50000)
        throw new Error('Повторный файл или слишком большой ZIP.');
      names.add(key);
    } catch (error) {
      failure = error;
      return;
    }
    let handle;
    let bytes = 0;
    enqueue(async () => {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      handle = await open(join(destination, path), 'wx', 0o600);
      handles.add(handle);
    });
    entry.ondata = (error, chunk, final) => {
      if (error) failure = error;
      bytes += chunk?.length ?? 0;
      total += chunk?.length ?? 0;
      if (bytes > 512 * 1024 * 1024 || total > 2 * 1024 ** 3)
        failure = new Error('Распакованный ZIP превышает допустимый размер.');
      if (failure) {
        enqueue(() => close(handle));
        return;
      }
      const value = chunk.slice();
      enqueue(async () => {
        try {
          let offset = 0;
          while (offset < value.length)
            offset += (await handle.write(value, offset, value.length - offset)).bytesWritten;
        } finally {
          if (final) await close(handle);
        }
      });
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(archive)) {
      unzip.push(chunk);
      await pending;
      if (failure) throw failure;
    }
    unzip.push(new Uint8Array(), true);
    await pending;
    if (failure) throw failure;
    return names.size;
  } finally {
    await pending.catch(() => undefined);
    await Promise.allSettled([...handles].map(close));
  }
}

/** Проверяет полный состав распакованного архива и восстанавливает права из манифеста. */
export async function verifyPortableFiles(root, expected) {
  const manifest = JSON.parse(await readFile(join(root, 'portable-manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== expected.version ||
    manifest.platform !== expected.platform ||
    manifest.arch !== expected.arch ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Манифест готовой поставки не соответствует системе или версии.');
  const actual = await portableInventory(root);
  const files = new Map(actual.map((file) => [file.path, file]));
  if (files.size !== manifest.files.length + 1)
    throw new Error('Состав ZIP отличается от манифеста.');
  const checked = new Set();
  for (const file of manifest.files) {
    archivePath('root/' + file.path, 'root');
    const saved = files.get(file.path);
    if (
      checked.has(file.path) ||
      !saved ||
      ![0o644, 0o755].includes(file.mode) ||
      saved.bytes !== file.bytes ||
      saved.sha256 !== file.sha256
    )
      throw new Error('Повреждённый файл поставки: ' + file.path);
    checked.add(file.path);
    await chmod(join(root, file.path), file.mode);
  }
  return manifest;
}
