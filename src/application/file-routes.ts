import { ApplicationError } from '../shared/application-error.js';
import { z } from 'zod';
import type { Application } from './bootstrap.js';
import { FileChanges } from '../tools/file-changes.js';
const selection = z.object({ runId: z.string().uuid(), changeId: z.string().uuid() });

/** Восстановление доступно только человеку через локальный канал, вне списка MCP-инструментов. */
export async function fileCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  const files = new FileChanges(app.sessions);
  if (method === 'files.preview') {
    const args = z
      .object({ approvalId: z.string().uuid(), offset: z.number().int().nonnegative().default(0) })
      .strict()
      .parse(input);
    return files.previewApproval(args.approvalId, args.offset);
  }
  if (method === 'files.previewRestore') {
    const args = selection
      .extend({ offset: z.number().int().nonnegative().default(0) })
      .strict()
      .parse(input);
    assertStandalone(app, args.runId);
    return files.previewRestore(args.runId, args.changeId, args.offset);
  }
  if (method === 'files.previewResolution') {
    const args = selection.strict().parse(input);
    assertStandalone(app, args.runId);
    return files.previewResolution(args.runId, args.changeId);
  }
  if (method === 'files.restore' || method === 'files.resolveRestore') {
    const restore = selection.extend({ previewToken: z.string().length(64) });
    const args =
      method === 'files.resolveRestore'
        ? restore
            .extend({ result: z.string().trim().min(1).max(10000) })
            .strict()
            .parse(input)
        : { ...restore.strict().parse(input), result: undefined };
    assertStandalone(app, args.runId);
    if (app.runtime.busy())
      throw new ApplicationError('TASK_BUSY', 'Сначала завершите работающие задачи.');
    await app.scheduler.schedule('write', async () => {
      assertStandalone(app, args.runId);
      if (app.runtime.busy())
        throw new ApplicationError(
          'TASK_BUSY',
          'Появилась работающая задача. Повторите восстановление после её завершения.',
        );
      if (args.result !== undefined)
        await files.resolveRestore(args.runId, args.changeId, args.previewToken, args.result);
      else await files.restore(args.runId, args.changeId, args.previewToken);
    });
    return method === 'files.resolveRestore' ? { resolved: true } : { restored: true };
  }
  throw new Error('Неизвестная команда файлов.');
}

/** Изменения этапа восстанавливает только проектный сценарий с проверкой всей рабочей папки. */
function assertStandalone(app: Application, runId: string): void {
  if (app.sessions.catalog(true).find((run) => run.id === runId)?.project)
    throw new ApplicationError(
      'PROJECT_MANAGED',
      'Файлы изменены этапом проекта. Откройте проект для проверки результата.',
    );
}
