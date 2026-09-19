import { z } from 'zod';
import type { Application } from './bootstrap.js';
import {
  draftLocationSchema,
  draftScopeSchema,
  draftUpdateSchema,
  taskTextLimit,
} from '../sessions/drafts.js';

/** Черновики доступны только человеку через локальный канал, без инструментов модели. */
export async function draftCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  const operation = () =>
    app.sessions.withStateFiles(async () => {
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
    });
  // Сначала очередь проекта, затем файлов: каскад удаления использует тот же порядок.
  const scoped = method === 'drafts.list' || method === 'drafts.create';
  const scope = scoped
    ? z.object({ scope: draftScopeSchema }).parse(input).scope
    : (
        await app.drafts.get(
          draftLocationSchema.parse(
            z
              .object({ id: z.string().uuid(), sessionId: z.string().uuid().optional() })
              .parse(input),
          ),
        )
      ).scope;
  return scope.purpose ? app.projects.withDraftScope(scope, operation) : operation();
}
