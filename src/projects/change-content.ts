import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectCaptureSettings } from '../configuration/project-capture.js';
import { Serial } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { assertRealDirectory } from '../sessions/files.js';
import type { WorkspaceSnapshot } from './workspace.js';
import {
  contentManifestSchema,
  type ContentManifest,
  type ContentEntry,
} from './change-content-schema.js';
import {
  contentDirectory,
  contentDirectories,
  contentDigest,
  maximumContentManifestBytes,
  publishContent,
  readContentBytes,
} from './change-content-files.js';

export type { ContentManifest, ContentEntry } from './change-content-schema.js';
export type ContentRecorder = (entry: ContentEntry, bytes?: Buffer) => Promise<void>;

/** Владелец состояния сохраняет копии последовательно; журналы ссылаются лишь на готовые объекты. */
export class ProjectChangeContentStore {
  private readonly serial = new Serial();
  private sizes?: Map<string, number>;
  constructor(private readonly directory: string) {}

  /** Сохраняет допустимые копии из того же чтения, которым вычислялся отпечаток папки. */
  capture(
    projectId: string,
    settings: ProjectCaptureSettings,
    work: (record: ContentRecorder) => Promise<WorkspaceSnapshot>,
    link?: ContentManifest['link'],
  ): Promise<WorkspaceSnapshot> {
    return this.serial.run(async () => {
      try {
        const root = await contentDirectories(this.directory, projectId, true);
        const sizes = await this.measure();
        let total = [...sizes.values()].reduce((sum, size) => sum + size, 0);
        let project = sizes.get(projectId) ?? 0;
        const entries: ContentEntry[] = [];
        const snapshot = await work(async (entry, bytes) => {
          if (bytes) {
            const path = join(root, 'blobs', entry.digest);
            let existing = false;
            try {
              const saved = await readContentBytes(path, settings.fileBytes);
              if (!saved.equals(bytes)) throw new Error('Сохранённая копия повреждена.');
              existing = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (
              existing ||
              (project + bytes.length <= settings.projectBytes &&
                total + bytes.length <= settings.totalBytes)
            ) {
              if (!existing) {
                await publishContent(path, bytes);
                project += bytes.length;
                total += bytes.length;
                sizes.set(projectId, project);
              }
              entries.push({
                ...entry,
                content: { digest: entry.digest, bytes: bytes.length },
                unavailableReason: undefined,
              });
            } else {
              entries.push({
                ...entry,
                unavailableReason:
                  project + bytes.length > settings.projectBytes ? 'project-limit' : 'total-limit',
              });
            }
          } else entries.push(entry);
        });
        const manifest: ContentManifest = {
          schemaVersion: 1,
          projectId,
          createdAt: snapshot.createdAt,
          snapshotDigest: snapshot.digest,
          snapshotRef: snapshot.ref,
          ...(link ? { link } : {}),
          entries,
        };
        const bytes = Buffer.from(JSON.stringify(manifest));
        if (bytes.length > maximumContentManifestBytes)
          throw new Error('Манифест содержимого превышает 16 МиБ.');
        const key = contentDigest(bytes);
        await publishContent(join(root, 'manifests', key + '.json'), bytes);
        return {
          ...snapshot,
          contentRef: 'project-content/' + projectId + '/manifests/' + key + '.json',
        };
      } catch (error) {
        // После частичной записи повторное измерение учитывает даже ещё не привязанные копии.
        this.sizes = undefined;
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError(
          'STORAGE_UNAVAILABLE',
          'Не удалось сохранить версии файлов проекта.',
          { cause: error },
        );
      }
    });
  }

  /** Проверяет принадлежность, предел и checksum манифеста без чтения исходной папки. */
  async readContentManifest(projectId: string, ref: string): Promise<ContentManifest> {
    const prefix = 'project-content/' + projectId + '/manifests/';
    contentDirectory(this.directory, projectId);
    if (!ref.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(ref.slice(prefix.length)))
      throw new ApplicationError('INVALID_REQUEST', 'Содержимое не принадлежит проекту.');
    try {
      const root = await contentDirectories(this.directory, projectId);
      const bytes = await readContentBytes(
        join(root, 'manifests', ref.slice(prefix.length)),
        maximumContentManifestBytes,
      );
      if (contentDigest(bytes) !== ref.slice(prefix.length, -5))
        throw new Error('Контрольная сумма манифеста не совпадает.');
      const manifest = contentManifestSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      if (
        manifest.projectId !== projectId ||
        !manifest.snapshotRef.startsWith('project-artifacts/' + projectId + '/') ||
        new Set(manifest.entries.map((entry) => entry.path)).size !== manifest.entries.length
      )
        throw new Error('Неверная связь манифеста с проектом.');
      const digest = createHash('sha256');
      for (const entry of manifest.entries)
        digest.update(
          JSON.stringify({
            path: entry.path,
            kind: entry.kind,
            digest: entry.digest,
            executable: entry.executable,
          }) + '\n',
        );
      if (digest.digest('hex') !== manifest.snapshotDigest)
        throw new Error('Содержимое не совпадает с отпечатком папки.');
      return manifest;
    } catch (error) {
      throw new ApplicationError(
        'STORAGE_UNAVAILABLE',
        'Сохранённые исходники недоступны или повреждены.',
        { cause: error },
      );
    }
  }

  /** Находит готовую точку после сбоя между публикацией файлов и записью проектного события. */
  async findAfter(
    projectId: string,
    runId: string,
    changeSetId: string,
  ): Promise<WorkspaceSnapshot | undefined> {
    const root = await contentDirectories(this.directory, projectId);
    let files;
    try {
      files = await opendir(join(root, 'manifests'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let found: WorkspaceSnapshot | undefined;
    for await (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const ref = 'project-content/' + projectId + '/manifests/' + file.name;
      const manifest = await this.readContentManifest(projectId, ref);
      if (
        manifest.link?.runId !== runId ||
        manifest.link.changeSetId !== changeSetId ||
        (found && found.createdAt <= manifest.createdAt)
      )
        continue;
      found = {
        digest: manifest.snapshotDigest,
        ref: manifest.snapshotRef,
        createdAt: manifest.createdAt,
        files: manifest.entries.length,
        contentRef: ref,
      };
    }
    return found;
  }

  /** Возвращает только текст указанного в проверенном манифесте файла. */
  async readContent(projectId: string, ref: string, path: string): Promise<string> {
    const manifest = await this.readContentManifest(projectId, ref);
    const entry = manifest.entries.find((item) => item.path === path);
    if (!entry?.content)
      throw new ApplicationError('INVALID_REQUEST', 'Текст этого файла не сохранён.');
    try {
      const root = await contentDirectories(this.directory, projectId);
      const bytes = await readContentBytes(
        join(root, 'blobs', entry.content.digest),
        entry.content.bytes,
      );
      if (
        bytes.length !== entry.content.bytes ||
        contentDigest(bytes) !== entry.content.digest ||
        bytes.includes(0)
      )
        throw new Error('Контрольная сумма содержимого не совпадает.');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new ApplicationError(
        'STORAGE_UNAVAILABLE',
        'Сохранённый текст недоступен или повреждён.',
        { cause: error },
      );
    }
  }

  /** Сбрасывает производные размеры после полного удаления проекта или сброса состояния. */
  forget(_projectId?: string): void {
    this.sizes = undefined;
  }

  /** Показывает фактически занятые байты, включая копии незавершённой записи. */
  async usage(): Promise<{ totalBytes: number; projects: Record<string, number> }> {
    const sizes = await this.measure();
    return {
      totalBytes: [...sizes.values()].reduce((sum, size) => sum + size, 0),
      projects: Object.fromEntries(sizes),
    };
  }

  /** Читает только размеры blob-файлов; текст исходников для учёта лимитов не загружается. */
  private async measure(): Promise<Map<string, number>> {
    if (this.sizes) return this.sizes;
    const sizes = new Map<string, number>();
    const root = join(this.directory, 'project-content');
    await assertRealDirectory(this.directory);
    await assertRealDirectory(root);
    let folders;
    try {
      folders = await opendir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (this.sizes = sizes);
      throw error;
    }
    for await (const folder of folders) {
      if (!folder.isDirectory() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(folder.name)) {
        if (folder.isSymbolicLink()) throw new Error('Каталог копий заменён ссылкой.');
        continue;
      }
      const blobs = join(root, folder.name, 'blobs');
      await assertRealDirectory(blobs);
      let files;
      try {
        files = await opendir(blobs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let size = 0;
      for await (const file of files) {
        if (!/^[a-f0-9]{64}$/.test(file.name)) continue;
        const stat = await lstat(join(blobs, file.name));
        if (!stat.isFile()) throw new Error('Копия исходника заменена ссылкой или каталогом.');
        size += stat.size;
      }
      sizes.set(folder.name, size);
    }
    return (this.sizes = sizes);
  }
}
