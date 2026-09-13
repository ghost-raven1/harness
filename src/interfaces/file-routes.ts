import { z } from 'zod';
import type { Application } from './application.js';
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
    return files.previewRestore(args.runId, args.changeId, args.offset);
  }
  if (method === 'files.restore') {
    const args = selection
      .extend({ previewToken: z.string().length(64) })
      .strict()
      .parse(input);
    if (app.runtime.busy()) throw new Error('Сначала завершите работающие задачи.');
    await app.scheduler.schedule('write', async () => {
      if (app.runtime.busy())
        throw new Error(
          'Появилась работающая задача. Повторите восстановление после её завершения.',
        );
      await files.restore(args.runId, args.changeId, args.previewToken);
    });
    return { restored: true };
  }
  throw new Error('Неизвестная команда файлов.');
}
