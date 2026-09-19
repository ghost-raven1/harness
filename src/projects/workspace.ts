import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, opendir, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import { isWithin } from '../configuration/loader.js';
import { ApplicationError } from '../shared/application-error.js';
import { assertRealDirectory, syncDirectory } from '../sessions/files.js';

const excluded = new Set([
  '.git',
  'node_modules',
  '.harness',
  '.tools',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
]);
const secrets = ['**/.env', '**/.env.*', '**/*.{pem,key,p12,pfx}', '**/id_rsa', '**/id_ed25519'];
const maximumEntries = 50_000;
const maximumManifestBytes = 16 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !value.includes('\\') &&
          !value.includes('\0') &&
          !value.startsWith('/') &&
          value.split('/').every((part) => part !== '.' && part !== '..' && part !== ''),
      ),
    kind: z.enum(['file', 'symlink']),
    digest: hashSchema,
    executable: z.boolean(),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
export interface WorkspaceSnapshot {
  digest: string;
  ref: string;
  files: number;
  createdAt: string;
}
export interface WorkspaceChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
}

/** Метаданные ловят замену inode, изменение содержимого и прав во время чтения. */
function fingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Имена артефактов не позволяют выйти из каталога выбранного проекта. */
function projectDirectory(directory: string, projectId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId))
    throw new ApplicationError('INVALID_REQUEST', 'Некорректный идентификатор проекта.');
  return join(directory, 'project-artifacts', projectId);
}

/** Хранит ограниченные манифесты хешей, не копируя и не изменяя исходные файлы. */
export class ProjectWorkspace {
  constructor(private readonly directory: string) {}

  /** Проверяет весь доступный снимок; частичный или меняющийся обход не публикуется. */
  async capture(
    projectId: string,
    workspace: string,
    deniedPaths: string[],
  ): Promise<WorkspaceSnapshot> {
    const destination = projectDirectory(this.directory, projectId);
    for (const path of [this.directory, dirname(destination), destination]) {
      await assertRealDirectory(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    const root = await realpath(workspace);
    const artifacts = await realpath(dirname(destination));
    const id = randomUUID();
    const ref = 'project-artifacts/' + projectId + '/' + id + '.jsonl';
    const temporary = join(destination, id + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    const createdAt = new Date().toISOString();
    const digest = createHash('sha256');
    const observed = new Map<string, string>();
    let files = 0;
    let bytes = 0;
    let visited = 0;
    const write = async (value: unknown): Promise<void> => {
      const line = JSON.stringify(value) + '\n';
      bytes += Buffer.byteLength(line);
      if (bytes > maximumManifestBytes)
        throw new ApplicationError(
          'PROJECT_CHANGED',
          'Манифест папки превышает 16 МиБ. Уточните исключения проекта.',
        );
      await handle.writeFile(line);
    };
    const record = async (value: Entry): Promise<void> => {
      const entry = entrySchema.parse(value);
      digest.update(JSON.stringify(entry) + '\n');
      await write(entry);
      files++;
    };
    const denied = (local: string): boolean => {
      const parts = local.split('/');
      return (
        parts.some((part) => excluded.has(part)) ||
        [...secrets, ...deniedPaths].some((pattern) =>
          parts.some((_, index) =>
            minimatch(parts.slice(0, index + 1).join('/'), pattern, {
              dot: true,
              nocase: process.platform === 'win32',
            }),
          ),
        )
      );
    };
    const visit = async (path: string, local: string): Promise<void> => {
      if (local && (denied(local) || isWithin(artifacts, path))) return;
      if (++visited > maximumEntries)
        throw new ApplicationError(
          'PROJECT_CHANGED',
          'В папке больше 50 000 записей. Уточните исключения проекта.',
        );
      const before = await lstat(path, { bigint: true });
      observed.set(path, fingerprint(before));
      if (before.isSymbolicLink()) {
        const target = await readlink(path);
        const portable = (isAbsolute(target) ? relative(dirname(path), target) : target)
          .split(sep)
          .join('/');
        const entry: Entry = {
          path: local,
          kind: 'symlink',
          executable: false,
          digest: createHash('sha256').update(portable).digest('hex'),
        };
        await record(entry);
      } else if (before.isDirectory()) {
        if ((await realpath(path)) !== path)
          throw new Error('Папка заменена ссылкой во время чтения.');
        const children: string[] = [];
        for await (const child of await opendir(path)) {
          const childLocal = local ? local + '/' + child.name : child.name;
          if (!denied(childLocal) && !isWithin(artifacts, join(path, child.name))) {
            if (children.length + visited >= maximumEntries)
              throw new Error('В папке больше 50 000 записей. Уточните исключения проекта.');
            children.push(child.name);
          }
        }
        children.sort();
        for (const name of children)
          await visit(join(path, name), local ? local + '/' + name : name);
      } else if (before.isFile()) {
        if ((await realpath(path)) !== path)
          throw new Error('Путь файла изменился во время чтения.');
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (fingerprint(await file.stat({ bigint: true })) !== fingerprint(before))
            throw new Error('Файл заменён перед чтением.');
          const content = createHash('sha256');
          if (before.size > 0n)
            for await (const chunk of file.createReadStream({
              autoClose: false,
              highWaterMark: 64 * 1024,
              end: Number(before.size) - 1,
            }))
              content.update(chunk);
          if (fingerprint(await file.stat({ bigint: true })) !== fingerprint(before))
            throw new Error('Файл изменён во время чтения.');
          const entry: Entry = {
            path: local,
            kind: 'file',
            digest: content.digest('hex'),
            executable: (before.mode & 0o111n) !== 0n,
          };
          await record(entry);
        } finally {
          await file.close();
        }
      }
      if (fingerprint(await lstat(path, { bigint: true })) !== fingerprint(before))
        throw new Error('Папка или файл изменились во время обхода.');
    };
    try {
      await write({ schemaVersion: 1, projectId, createdAt });
      try {
        await visit(root, '');
        for (const [path, state] of observed)
          if (fingerprint(await lstat(path, { bigint: true })) !== state)
            throw new Error('Исходные файлы изменились до завершения снимка.');
        if ((await realpath(workspace)) !== root) throw new Error('Рабочая папка заменена.');
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (
          ['ENOSPC', 'EIO', 'EROFS', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw new ApplicationError(
            'STORAGE_UNAVAILABLE',
            'Не удалось сохранить снимок проекта.',
            { cause: error },
          );
        throw new ApplicationError(
          'PROJECT_CHANGED',
          'Папка изменилась или недоступна. Повторите проверку проекта.',
          { cause: error },
        );
      }
      const value = digest.digest('hex');
      await write({ digest: value, files });
      await handle.sync();
      await handle.close();
      await rename(temporary, resolve(this.directory, ref));
      await syncDirectory(destination);
      return { digest: value, ref, files, createdAt };
    } finally {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** Возвращает изменения исходников; сравнение ничего не откатывает и не записывает в папку. */
  async changes(
    projectId: string,
    beforeRef: string,
    afterRef: string,
  ): Promise<WorkspaceChange[]> {
    const before = await this.read(projectId, beforeRef);
    const after = await this.read(projectId, afterRef);
    const result: WorkspaceChange[] = [];
    for (const [path, entry] of before) {
      const next = after.get(path);
      if (!next) result.push({ path, kind: 'deleted' });
      else if (
        entry.digest !== next.digest ||
        entry.kind !== next.kind ||
        entry.executable !== next.executable
      )
        result.push({ path, kind: 'modified' });
    }
    for (const path of after.keys()) if (!before.has(path)) result.push({ path, kind: 'added' });
    return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Проверяет принадлежность, размер и контрольную сумму манифеста при каждом чтении. */
  private async read(projectId: string, ref: string): Promise<Map<string, Entry>> {
    const directory = projectDirectory(this.directory, projectId);
    const prefix = 'project-artifacts/' + projectId + '/';
    if (!ref.startsWith(prefix) || !/^[a-f0-9-]{36}\.jsonl$/.test(ref.slice(prefix.length)))
      throw new ApplicationError('INVALID_REQUEST', 'Снимок не принадлежит проекту.');
    for (const path of [this.directory, dirname(directory), directory])
      await assertRealDirectory(path);
    const path = resolve(this.directory, ref);
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maximumManifestBytes))
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Некорректный файл снимка проекта.');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const input = file.createReadStream({ autoClose: false });
    let bytes = 0;
    input.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maximumManifestBytes)
        input.destroy(new Error('Снимок превысил допустимый размер.'));
    });
    const lines = createInterface({ input, crlfDelay: Infinity });
    const entries = new Map<string, Entry>();
    const digest = createHash('sha256');
    let header = false;
    let footer: { digest: string; files: number } | undefined;
    try {
      for await (const line of lines) {
        const json: unknown = JSON.parse(line);
        if (!header) {
          z.object({
            schemaVersion: z.literal(1),
            projectId: z.literal(projectId),
            createdAt: z.string().datetime(),
          })
            .strict()
            .parse(json);
          header = true;
        } else if (json && typeof json === 'object' && 'path' in json) {
          if (footer || entries.size >= maximumEntries)
            throw new Error('Некорректный порядок записей снимка.');
          const entry = entrySchema.parse(json);
          if (entries.has(entry.path)) throw new Error('Повтор пути в снимке.');
          entries.set(entry.path, entry);
          digest.update(JSON.stringify(entry) + '\n');
        } else {
          if (footer) throw new Error('Повтор контрольной суммы снимка.');
          footer = z
            .object({ digest: hashSchema, files: z.number().int().nonnegative() })
            .strict()
            .parse(json);
        }
      }
      if (
        !header ||
        !footer ||
        footer.files !== entries.size ||
        footer.digest !== digest.digest('hex') ||
        fingerprint(await lstat(path, { bigint: true })) !== fingerprint(stat)
      )
        throw new Error('Контрольная сумма снимка не совпадает.');
      return entries;
    } catch (error) {
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Снимок проекта повреждён или изменился.', {
        cause: error,
      });
    } finally {
      lines.close();
      input.destroy();
      await file.close();
    }
  }
}
