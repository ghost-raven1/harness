import { z } from 'zod';
import type { Application } from './application.js';
import {
  draftLocationSchema,
  draftScopeSchema,
  draftUpdateSchema,
  taskTextLimit,
} from '../sessions/drafts.js';

/** Черновики доступны только человеку через локальный канал, без инструментов модели. */
export function draftCommand(app: Application, method: string, input: unknown): Promise<unknown> {
  return app.scheduler.schedule(
    method === 'drafts.list' || method === 'drafts.get' ? 'read' : 'write',
    async () => {
      switch (method) {
        case 'drafts.list': {
          const args = z
            .object({ scope: draftScopeSchema, offset: z.number().int().nonnegative().default(0) })
            .strict()
            .parse(input);
          return app.drafts.list(args.scope, args.offset);
        }
        case 'drafts.get':
          return app.drafts.get(draftLocationSchema.parse(input));
        case 'drafts.create': {
          const args = z
            .object({
              scope: draftScopeSchema,
              text: z.string().max(taskTextLimit).optional(),
              requestKey: z.string().min(1).max(200).optional(),
            })
            .strict()
            .parse(input);
          return app.drafts.create(args.scope, args.text, args.requestKey);
        }
        case 'drafts.update':
          return app.drafts.update(draftUpdateSchema.parse(input));
        case 'drafts.rebase': {
          const { expectedRevision, parentRunId, ...location } = draftLocationSchema
            .extend({
              expectedRevision: z.number().int().nonnegative(),
              parentRunId: z.string().uuid(),
            })
            .parse(input);
          return app.drafts.rebase(location, expectedRevision, parentRunId);
        }
        case 'drafts.remove': {
          const { expectedRevision, ...location } = draftLocationSchema
            .extend({ expectedRevision: z.number().int().nonnegative() })
            .parse(input);
          await app.drafts.remove(location, expectedRevision);
          return { removed: true };
        }
        default:
          throw new Error('Неизвестная команда черновиков.');
      }
    },
  );
}
