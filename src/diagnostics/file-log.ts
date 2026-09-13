import { lstat, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Serial } from '../shared/primitives.js';
import { atomicJson } from '../sessions/files.js';
import {
  appendDiagnostic,
  checkDiagnosticFile,
  diagnosticDirectory,
  UnsafeDiagnosticPath,
} from './files.js';
import {
  diagnosticCodes,
  diagnosticMethod,
  type DiagnosticEvent,
  type DiagnosticStatus,
} from './types.js';

const settingsSchema = z.object({ enabled: z.boolean() }).strict();
const eventSchema = z.union([
  z.object({ type: z.enum(['service.started', 'service.stopped']) }),
  z.object({
    type: z.literal('task.finished'),
    runId: z.string().uuid(),
    status: z.enum(['completed', 'failed']),
  }),
  z.object({
    type: z.enum(['command.succeeded', 'command.failed']),
    method: z.string().transform(diagnosticMethod),
    durationMs: z.number().int().min(0).max(86400000),
    code: z.enum(diagnosticCodes).optional(),
  }),
]);

/** Опциональный журнал с одним писателем; ошибки диагностики не останавливают работу Harness. */
export class FileDiagnosticLog {
  private readonly serial = new Serial();
  private readonly root: string;
  private readonly settingsFile: string;
  private enabled = false;
  private error?: string;
  private closed = false;
  readonly directory: string;
  readonly file: string;
  readonly retainedFiles = 3;
  readonly maxBytes: number;

  constructor(directory: string, options: { maxBytes?: number } = {}) {
    this.root = resolve(directory);
    this.settingsFile = join(this.root, 'diagnostics.json');
    this.directory = join(this.root, 'logs');
    this.file = join(this.directory, 'harness.jsonl');
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
  }

  async initialize(): Promise<void> {
    await this.serial.run(async () => {
      try {
        await diagnosticDirectory(this.root);
        await checkDiagnosticFile(this.settingsFile);
        try {
          this.enabled = settingsSchema.parse(
            JSON.parse(await readFile(this.settingsFile, 'utf8')),
          ).enabled;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (this.enabled) await this.prepareFiles();
        this.error = undefined;
      } catch (error) {
        this.failure(error);
      }
    });
  }

  status(): DiagnosticStatus {
    return {
      enabled: this.enabled,
      file: this.file,
      directory: this.directory,
      maxBytes: this.maxBytes,
      retainedFiles: this.retainedFiles,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<DiagnosticStatus> {
    await this.serial.run(async () => {
      if (this.closed) return;
      try {
        await diagnosticDirectory(this.root);
        await checkDiagnosticFile(this.settingsFile);
        if (enabled) await this.prepareFiles();
        await atomicJson(this.settingsFile, { enabled });
        this.enabled = enabled;
        this.error = undefined;
      } catch (error) {
        this.failure(error);
      }
    });
    return this.status();
  }

  async record(event: DiagnosticEvent): Promise<void> {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) return;
    const line = JSON.stringify({ at: new Date().toISOString(), ...parsed.data }) + '\n';
    await this.serial.run(async () => {
      if (!this.enabled || this.closed) return;
      try {
        await this.prepareFiles();
        let size = 0;
        try {
          size = (await lstat(this.file)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
        if (Buffer.byteLength(line) <= this.maxBytes) await appendDiagnostic(this.file, line);
        this.error = undefined;
      } catch (error) {
        this.failure(error);
      }
    });
  }

  flush(): Promise<void> {
    return this.serial.run(async () => undefined);
  }
  close(): Promise<void> {
    return this.serial.run(async () => {
      this.closed = true;
    });
  }

  private async prepareFiles(): Promise<void> {
    await diagnosticDirectory(this.root);
    await diagnosticDirectory(this.directory);
    for (let index = 0; index < this.retainedFiles; index++)
      await checkDiagnosticFile(this.rotatedFile(index));
  }

  private rotatedFile(index: number): string {
    return index === 0 ? this.file : join(this.directory, 'harness.' + index + '.jsonl');
  }

  private async rotate(): Promise<void> {
    await rm(this.rotatedFile(this.retainedFiles - 1), { force: true });
    for (let index = this.retainedFiles - 2; index >= 0; index--) {
      try {
        await rename(this.rotatedFile(index), this.rotatedFile(index + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private failure(error: unknown): void {
    this.error =
      error instanceof UnsafeDiagnosticPath
        ? 'Запись недоступна: путь журнала содержит ссылку или обычный файл вместо папки. Укажите безопасный каталог состояния.'
        : 'Не удалось прочитать настройки или записать лог. Проверьте доступ к каталогу состояния и свободное место.';
  }
}
