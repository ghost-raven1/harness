import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { atomicJson } from '../sessions/files.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { ToolContext } from './registry.js';
import { safePath } from './paths.js';
import { abort, hash, id } from '../shared/primitives.js';
import { ToolOutcomeUnknownError } from './errors.js';

export interface FileChange {
  id: string;
  path: string;
  canonical: string;
  beforeHash: string;
  afterHash: string;
  existed: boolean;
  status: 'prepared' | 'applied' | 'restoring' | 'restored';
  invocationId?: string;
}
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const backupSchema = z.object({
  content: z.string(),
  mode: z.number().int(),
  existed: z.boolean(),
});
const maxBytes = 4 * 1024 * 1024;
/** Читает содержимое и права файла для отката; отсутствие файла сохраняет отдельно. */
async function snapshot(path: string) {
  try {
    const meta = await stat(path);
    if (!meta.isFile() || meta.size > maxBytes)
      throw new Error('Для записи с резервной копией нужен обычный файл не больше 4 МиБ.');
    const bytes = await readFile(path);
    if (bytes.length > maxBytes)
      throw new Error('Файл вырос во время чтения. Повторите предпросмотр.');
    return { bytes, existed: true, mode: meta.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { bytes: Buffer.alloc(0), existed: false, mode: 0o600 };
  }
}
/** Связывает подтверждение с путём, исходным состоянием и предлагаемым содержимым. */
function token(path: string, before: Awaited<ReturnType<typeof snapshot>>, after: Buffer): string {
  return hash({
    path,
    before: digest(before.bytes),
    existed: before.existed,
    mode: before.mode,
    after: digest(after),
  });
}
/** Возвращает страницу изменений; для двоичных файлов показывает только размеры. */
function diff(path: string, before: Buffer, after: Buffer, offset = 0) {
  const patch =
    before.includes(0) || after.includes(0)
      ? 'Двоичный файл: было ' + before.length + ' байт, станет ' + after.length + ' байт.'
      : createTwoFilesPatch(
          'До: ' + path,
          'После: ' + path,
          before.toString('utf8'),
          after.toString('utf8'),
          '',
          '',
          { context: 3, timeout: 1000, maxEditLength: 10000 },
        );
  if (patch === undefined)
    throw new Error('Слишком большой diff для просмотра. Разбейте запись на меньшие изменения.');
  return {
    diff: patch.slice(offset, offset + 12000),
    next: offset + 12000 < patch.length ? offset + 12000 : undefined,
  };
}

/** Хранит исходные байты до записи и восстанавливает их только поверх ожидаемой версии. */
export class FileChanges {
  constructor(private readonly store: FileSessionStore) {}
  /** Восстанавливает рабочую папку и закреплённую конфигурацию задачи для файловых проверок. */
  private context(runId: string): ToolContext {
    const run = this.store.get(runId);
    return {
      runId,
      workspace: run.workspace,
      config: run.config.value,
      signal: new AbortController().signal,
    };
  }
  /** Показывает ожидающую разрешения запись и выдаёт токен текущего состояния файла. */
  async previewApproval(approvalId: string, offset = 0) {
    const run = this.store.list().find((run) => run.approvals[approvalId]);
    const approval = run?.approvals[approvalId];
    if (!run || !approval || approval.status !== 'pending' || approval.tool !== 'fs.write')
      throw new Error('Запись больше не ожидает решения.');
    const args = z
      .object({ path: z.string(), content: z.string().max(1048576) })
      .strict()
      .parse(approval.args);
    const path = await safePath(args.path, this.context(run.id), true),
      before = await snapshot(path),
      after = Buffer.from(args.content);
    return {
      path: args.path,
      previewToken: token(path, before, after),
      ...diff(args.path, before.bytes, after, offset),
    };
  }
  /** Сохраняет резервную копию и проверяет предпросмотр перед записью; неопределённый исход требует проверки. */
  async write(local: string, content: string, context: ToolContext) {
    const path = await safePath(local, context, true),
      before = await snapshot(path),
      after = Buffer.from(content);
    if (context.previewToken && context.previewToken !== token(path, before, after))
      throw new Error(
        'Файл изменился после предпросмотра. Запись отклонена; нужно новое разрешение.',
      );
    const change: FileChange = {
      id: id(),
      path: relative(context.workspace, path),
      canonical: path,
      beforeHash: digest(before.bytes),
      afterHash: digest(after),
      existed: before.existed,
      status: 'prepared',
      invocationId: context.invocationId,
    };
    await atomicJson(this.backupPath(context.runId, change.id), {
      content: before.bytes.toString('base64'),
      mode: before.mode,
      existed: before.existed,
    });
    await this.store.mutate(
      context.runId,
      'file.backup_created',
      { changeId: change.id, path: change.path },
      (state) => {
        (state.fileChanges ??= []).push(change);
      },
    );
    abort(context.signal);
    const verifiedPath = await safePath(local, context, true);
    if (verifiedPath !== path) throw new Error('Путь изменился во время подготовки записи.');
    const current = await snapshot(verifiedPath);
    if (token(path, current, after) !== token(path, before, after))
      throw new Error('Файл изменился во время подготовки записи. Повторите операцию.');
    try {
      await writeFile(path, after, { signal: context.signal, mode: before.mode });
      await this.store.mutate(context.runId, 'file.written', { changeId: change.id }, (state) => {
        state.fileChanges!.find((item) => item.id === change.id)!.status = 'applied';
      });
    } catch {
      throw new ToolOutcomeUnknownError(
        'Запись прервалась. Исходный файл сохранён; проверьте фактический результат.',
      );
    }
    return { path: change.path, bytes: after.length, changeId: change.id };
  }
  /** Адресует резервную копию по идентификаторам задачи и изменения. */
  private backupPath(runId: string, changeId: string): string {
    return join(this.store.directory, 'file-backups', runId, changeId + '.json');
  }
  /** Проверяет завершение задачи, неизменность записанного файла и целостность резервной копии. */
  private async restoration(runId: string, changeId: string) {
    const run = this.store.get(runId),
      change = run.fileChanges?.find((item) => item.id === changeId);
    if (!['completed', 'failed', 'cancelled'].includes(run.status))
      throw new Error('Завершите или остановите задачу перед восстановлением файла.');
    if (!change || change.status !== 'applied')
      throw new Error(
        'Эту запись нельзя автоматически восстановить. Неизвестный исход требует ручной проверки.',
      );
    const path = await safePath(change.path, this.context(runId), true);
    if (path !== change.canonical)
      throw new Error('Путь к файлу изменился. Автоматическое восстановление остановлено.');
    const current = await snapshot(path);
    if (!current.existed || digest(current.bytes) !== change.afterHash)
      throw new Error(
        'Файл изменён после работы Harness. Восстановление не затронет ваши новые правки.',
      );
    const backup = backupSchema.parse(
      JSON.parse(await readFile(this.backupPath(runId, changeId), 'utf8')),
    );
    const bytes = Buffer.from(backup.content, 'base64');
    if (digest(bytes) !== change.beforeHash || backup.existed !== change.existed)
      throw new Error('Резервная копия повреждена.');
    return { change, path, current, backup, bytes };
  }
  /** Показывает откат к резервной копии и связывает его с текущим состоянием файла. */
  async previewRestore(runId: string, changeId: string, offset = 0) {
    const item = await this.restoration(runId, changeId);
    return {
      path: item.change.path,
      previewToken: token(item.path, item.current, item.bytes),
      ...diff(item.change.path, item.current.bytes, item.bytes, offset),
    };
  }
  /** Применяет подтверждённый откат и сохраняет факт восстановления в истории задачи. */
  async restore(runId: string, changeId: string, previewToken: string): Promise<void> {
    const item = await this.restoration(runId, changeId);
    if (previewToken !== token(item.path, item.current, item.bytes))
      throw new Error('Предпросмотр устарел. Откройте изменения снова.');
    await this.store.mutate(runId, 'file.restore_started', { changeId }, (state) => {
      state.fileChanges!.find((c) => c.id === changeId)!.status = 'restoring';
    });
    const verifiedPath = await safePath(item.change.path, this.context(runId), true);
    if (verifiedPath !== item.path)
      throw new Error('Путь к файлу изменился. Автоматическое восстановление остановлено.');
    const checked = await snapshot(verifiedPath);
    if (previewToken !== token(item.path, checked, item.bytes))
      throw new Error('Файл изменился; проверьте его вручную перед восстановлением.');
    if (item.backup.existed) await writeFile(item.path, item.bytes, { mode: item.backup.mode });
    else await unlink(item.path);
    await this.store.mutate(runId, 'file.restored', { changeId }, (state) => {
      state.fileChanges!.find((c) => c.id === changeId)!.status = 'restored';
      state.agents[state.rootAgentId]!.messages.push({
        role: 'user',
        content:
          '[Harness: пользователь восстановил исходное состояние файла ' +
          item.change.path +
          '. Учитывай это при продолжении задачи.]',
      });
    });
  }
}
