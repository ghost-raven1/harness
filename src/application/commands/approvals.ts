import { ApplicationError } from '../../shared/application-error.js';
import { z } from 'zod';
import type { Application } from '../bootstrap.js';
import { FileChanges } from '../../tools/file-changes.js';

/** Выполняет команды группы approvals через сервисы приложения. */
export async function approvalsCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'approvals.list':
      return app.sessions.recoveryError ? [] : app.approvals.pending();
    case 'approvals.decide': {
      const args = z
        .object({
          approvalId: z.string().uuid(),
          allow: z.boolean(),
          previewToken: z.string().length(64).optional(),
        })
        .strict()
        .parse(input);
      const approval = app.approvals.pending().find((item) => item.id === args.approvalId);
      if (args.allow && approval?.tool === 'fs.write') {
        const preview = await new FileChanges(app.sessions).previewApproval(args.approvalId);
        if (preview.previewToken !== args.previewToken)
          throw new ApplicationError(
            'STALE_PREVIEW',
            'Перед разрешением записи нужен актуальный предпросмотр файла.',
          );
      }
      await app.approvals.resolve(args.approvalId, args.allow, args.previewToken);
      return { decided: true };
    }
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
