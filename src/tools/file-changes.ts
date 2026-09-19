import { ApplicationError } from '../shared/application-error.js';
import { readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { z } from 'zod';
import { atomicJson } from '../sessions/files.js';
import type { SessionStore } from '../sessions/ports.js';
import type { ToolContext } from './registry.js';
import { safePath } from './paths.js';
import { abort, hash, id, message } from '../shared/primitives.js';
import { ToolOutcomeUnknownError } from './errors.js';

export interface FileChange {
  id: string;
  path: string;
  canonical: string;
  beforeHash: string;
  afterHash: string;
  existed: boolean;
  status: 'prepared' | 'applied' | 'restoring' | 'restored' | 'reviewed';
  resolution?: { at: string; result: string };
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
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Файл вырос во время чтения. Повторите предпросмотр.',
      );
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
  constructor(private readonly store: SessionStore) {}
  /** Восстанавливает рабочую папку и закреплённую конфигурацию задачи для файловых проверок. */
  private async context(runId: string): Promise<ToolContext> {
    const run = await this.store.load(runId);
    return {
      runId,
      workspace: run.workspace,
      config: run.config.value,
      signal: new AbortController().signal,
    };
  }
  /** Показывает ожидающую разрешения запись и выдаёт токен текущего состояния файла. */
  async previewApproval(approvalId: string, offset = 0) {
    const entry = this.store
      .catalog()
      .find((run) => run.pendingApprovals.some((approval) => approval.id === approvalId));
    const run = entry ? await this.store.load(entry.id) : undefined;
    const approval = run?.approvals[approvalId];
    if (!run || !approval || approval.status !== 'pending' || approval.tool !== 'fs.write')
      throw new ApplicationError('STALE_PREVIEW', 'Запись больше не ожидает решения.');
    const args = z
      .object({ path: z.string(), content: z.string().max(1048576) })
      .strict()
      .parse(approval.args);
    const path = await safePath(args.path, await this.context(run.id), true),
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
      throw new ApplicationError(
        'STALE_PREVIEW',
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
    if (verifiedPath !== path)
      throw new ApplicationError('STALE_PREVIEW', 'Путь изменился во время подготовки записи.');
    const current = await snapshot(verifiedPath);
    if (token(path, current, after) !== token(path, before, after))
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Файл изменился во время подготовки записи. Повторите операцию.',
      );
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
    const run = await this.store.load(runId),
      change = run.fileChanges?.find((item) => item.id === changeId);
    if (!['completed', 'failed', 'cancelled'].includes(run.status))
      throw new ApplicationError(
        'TASK_BUSY',
        'Завершите или остановите задачу перед восстановлением файла.',
      );
    if (!change || change.status !== 'applied')
      throw new ApplicationError(
        'UNKNOWN_OUTCOME',
        'Эту запись нельзя автоматически восстановить. Неизвестный исход требует ручной проверки.',
      );
    const path = await safePath(change.path, await this.context(runId), true);
    if (path !== change.canonical)
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Путь к файлу изменился. Автоматическое восстановление остановлено.',
      );
    const current = await snapshot(path);
    if (!current.existed || digest(current.bytes) !== change.afterHash)
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Файл изменён после работы Harness. Восстановление не затронет ваши новые правки.',
      );
    const backup = backupSchema.parse(
      JSON.parse(await readFile(this.backupPath(runId, changeId), 'utf8')),
    );
    const bytes = Buffer.from(backup.content, 'base64');
    if (digest(bytes) !== change.beforeHash || backup.existed !== change.existed)
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Резервная копия повреждена.');
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
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Предпросмотр устарел. Откройте изменения снова.',
      );
    await this.store.mutate(runId, 'file.restore_started', { changeId }, (state) => {
      // Проверка и маркер используют ту же очередь, что и создание нового запуска.
      if (this.store.catalog().some((run) => ['running', 'awaiting_approval'].includes(run.status)))
        throw new ApplicationError(
          'TASK_BUSY',
          'Появилась работающая задача. Завершите или остановите её перед восстановлением.',
        );
      if (
        this.store
          .catalog()
          .some((run) => run.sessionId === state.sessionId && run.status === 'paused')
      )
        throw new ApplicationError(
          'TASK_BUSY',
          'В этой беседе есть задача на паузе. Продолжите или остановите её перед восстановлением.',
        );
      const change = state.fileChanges?.find((c) => c.id === changeId);
      if (!change || change.status !== 'applied')
        throw new ApplicationError(
          'STALE_PREVIEW',
          'Состояние восстановления изменилось. Откройте изменения снова.',
        );
      change.status = 'restoring';
    });
    try {
      const verifiedPath = await safePath(item.change.path, await this.context(runId), true);
      if (verifiedPath !== item.path)
        throw new ApplicationError(
          'STALE_PREVIEW',
          'Путь к файлу изменился. Автоматическое восстановление остановлено.',
        );
      const checked = await snapshot(verifiedPath);
      if (previewToken !== token(item.path, checked, item.bytes))
        throw new ApplicationError(
          'STALE_PREVIEW',
          'Файл изменился; проверьте его вручную перед восстановлением.',
        );
    } catch (error) {
      // Файл ещё не меняли: отказ проверки не оставляет несуществующую операцию в работе.
      await this.store.mutate(
        runId,
        'file.restore_rejected',
        { changeId, error: message(error) },
        (state) => {
          const change = state.fileChanges!.find((item) => item.id === changeId)!;
          if (change.status === 'restoring') change.status = 'applied';
        },
      );
      throw error;
    }
    // После начала записи или удаления исход может быть неизвестен; автоматический повтор запрещён.
    if (item.backup.existed) await writeFile(item.path, item.bytes, { mode: item.backup.mode });
    else await unlink(item.path);
    await this.store.mutate(runId, 'file.restored', { changeId }, (state) => {
      const change = state.fileChanges!.find((c) => c.id === changeId)!;
      change.status = 'restored';
      delete change.resolution;
      state.agents[state.rootAgentId]!.messages.push({
        role: 'user',
        content:
          '[Harness: пользователь восстановил исходное состояние файла ' +
          item.change.path +
          '. Учитывай это при продолжении задачи.]',
      });
    });
  }

  /** Сравнивает прерванный откат с исходной и записанной версиями, не изменяя файл. */
  async previewResolution(runId: string, changeId: string) {
    const run = await this.store.load(runId);
    const change = run.fileChanges?.find((item) => item.id === changeId);
    if (!['completed', 'failed', 'cancelled', 'paused'].includes(run.status))
      throw new ApplicationError('TASK_BUSY', 'Сначала остановите задачу.');
    if (!change || change.status !== 'restoring')
      throw new ApplicationError('STALE_PREVIEW', 'Этот откат больше не требует проверки.');
    const path = await safePath(change.path, await this.context(runId), true);
    if (path !== change.canonical)
      throw new Error('Путь к файлу изменился. Верните исходный путь перед проверкой.');
    const current = await snapshot(path);
    const currentHash = digest(current.bytes);
    const outcome =
      current.existed === change.existed && currentHash === change.beforeHash
        ? 'restored'
        : current.existed && currentHash === change.afterHash
          ? 'applied'
          : 'reviewed';
    const description = {
      restored: 'Файл совпадает с исходным состоянием. Восстановление выполнено.',
      applied: 'Сохранилась версия, записанная задачей. Восстановление не выполнено.',
      reviewed: 'Файл отличается от обеих версий. Будет сохранён ваш результат ручной проверки.',
    }[outcome];
    return {
      path: change.path,
      outcome: outcome as 'restored' | 'applied' | 'reviewed',
      description,
      exists: current.existed,
      bytes: current.bytes.length,
      currentHash,
      previewToken: hash({
        runId,
        changeId,
        path,
        currentHash,
        existed: current.existed,
        mode: current.mode,
      }),
    };
  }

  /** Сохраняет подтверждённый исход отката; повторной записи или удаления файла нет. */
  async resolveRestore(
    runId: string,
    changeId: string,
    previewToken: string,
    result: string,
  ): Promise<void> {
    const explanation = z.string().trim().min(1).max(10000).parse(result);
    const preview = await this.previewResolution(runId, changeId);
    if (preview.previewToken !== previewToken)
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Файл изменился после проверки. Откройте проверку заново.',
      );
    await this.store.mutate(
      runId,
      'file.restore_resolved',
      { changeId, outcome: preview.outcome },
      (run) => {
        const change = run.fileChanges!.find((item) => item.id === changeId)!;
        if (change.status !== 'restoring')
          throw new ApplicationError('STALE_PREVIEW', 'Результат уже проверен в другом окне.');
        change.status = preview.outcome;
        change.resolution = { at: new Date().toISOString(), result: explanation };
        run.agents[run.rootAgentId]!.messages.push({
          role: 'user',
          content:
            '[Harness: пользователь проверил прерванное восстановление файла]\n' +
            JSON.stringify({ path: change.path, state: preview.description, result: explanation }),
        });
      },
    );
  }
}
