import { z } from 'zod';
import type { Application } from '../bootstrap.js';
import { queryCatalogHistory } from '../../sessions/history.js';
import { dataResetScopeSchema } from '../data-reset-records.js';
import { taskPreview } from '../result-pages.js';
import { runIdSchema } from './task-status.js';

/** Выполняет команды группы history через сервисы приложения. */
export async function historyCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'runtime.list': {
      const args = z
        .object({
          offset: z.number().int().nonnegative().safe().default(0),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
        .parse(input ?? {});
      return app.sessions
        .catalog()
        .reverse()
        .slice(args.offset, args.limit === undefined ? undefined : args.offset + args.limit)
        .map((run) => ({
          runId: run.id,
          status: app.runtime.visibleStatus(run.id, run.status),
          task: run.task,
          taskTruncated: run.taskTruncated,
          profile: run.profile,
          createdAt: run.createdAt,
        }))
        .map(taskPreview);
    }
    case 'runtime.history': {
      const args = z
        .object({
          query: z.string().max(200).default(''),
          page: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(10),
          includeDeleted: z.boolean().default(false),
        })
        .strict()
        .parse(input ?? {});
      const page = queryCatalogHistory(
        app.sessions.catalog(args.includeDeleted).map((run) => ({
          ...run,
          status: app.runtime.visibleStatus(run.id, run.status),
        })),
        await app.sessions.search(args.query, args.includeDeleted),
        args.page,
        args.limit,
      );
      return { ...page, active: page.active.map(taskPreview), items: page.items.map(taskPreview) };
    }
    case 'runtime.purgePreview':
      return app.purge.preview(runIdSchema.parse(input).runId);
    case 'runtime.purge': {
      const args = runIdSchema
        .extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(input);
      return app.purge.purge(args.runId, args.previewToken);
    }
    case 'runtime.delete': {
      const args = runIdSchema.parse(input);
      await app.sessions.delete(args.runId);
      return { deleted: true };
    }
    case 'maintenance.resetPreview': {
      const { scope } = z.object({ scope: dataResetScopeSchema }).strict().parse(input);
      return app.reset.preview(scope);
    }
    case 'maintenance.reset': {
      const { scope, previewToken } = z
        .object({
          scope: dataResetScopeSchema,
          previewToken: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(input);
      return app.reset.reset(scope, previewToken);
    }
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
