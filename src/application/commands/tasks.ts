import { z } from 'zod';
import type { Application } from '../bootstrap.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runInputSchema } from '../../runtime/engine.js';
import { runMessageSchema } from '../../runtime/messages.js';
import { taskEvent } from '../task-events.js';
import { resultCursorSchema, textPage } from '../result-pages.js';
import { runIdSchema, statusInputSchema, runStatus } from './task-status.js';

/** Выполняет команды группы tasks через сервисы приложения. */
export async function tasksCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'iterations.status': {
      const { runId } = z
        .object({ runId: z.string().uuid().optional() })
        .strict()
        .parse(input ?? {});
      return app.runtime.iterationStatus(runId);
    }
    case 'iterations.configure': {
      const args = z
        .object({
          limit: z.number().int().positive().safe(),
          runId: z.string().uuid().optional(),
          expectedLimit: z.number().int().positive().safe().optional(),
        })
        .strict()
        .parse(input);
      await app.runtime.setIterationLimit(args.limit, args.runId, args.expectedLimit);
      return app.runtime.iterationStatus(args.runId);
    }
    case 'runtime.task': {
      const args = statusInputSchema
        .extend({ outputCursor: z.number().int().min(0).default(0) })
        .parse(input);
      const status = await runStatus(app, args.runId, args.cursor, args.resultCursor);
      return {
        ...status,
        events: (await app.sessions.history(args.runId, args.cursor, 100)).map(taskEvent),
        output: await app.sessions.output.page(args.runId, args.outputCursor),
      };
    }
    case 'runtime.run':
      return app.runtime.start(runInputSchema.parse(input));
    case 'runtime.message':
      return app.runtime.sendMessage(runMessageSchema.parse(input));
    case 'runtime.result': {
      const args = runIdSchema.extend({ cursor: resultCursorSchema.default(0) }).parse(input);
      return textPage((await app.sessions.load(args.runId)).result ?? '', args.cursor);
    }
    case 'runtime.status': {
      const args = statusInputSchema.parse(input);
      const until = Date.now() + args.waitMs;
      while (
        !(await app.sessions.history(args.runId, args.cursor, 1)).length &&
        ['running', 'awaiting_approval'].includes((await app.sessions.load(args.runId)).status) &&
        Date.now() < until
      )
        await delay(100);
      return runStatus(app, args.runId, args.cursor, args.resultCursor);
    }
    case 'budget.status':
      return app.runtime.usage.status(
        z
          .object({ runId: z.string().uuid().optional() })
          .strict()
          .parse(input ?? {}).runId,
      );
    case 'runtime.cancel':
      await app.runtime.cancel(runIdSchema.parse(input).runId);
      return { cancelled: true };
    case 'runtime.resume':
      await app.runtime.resume(runIdSchema.parse(input).runId);
      return { resumed: true };
    case 'runtime.resolve': {
      const args = z
        .object({
          runId: z.string().uuid(),
          invocationId: z.string(),
          result: z.string().max(1000000),
          succeeded: z.boolean(),
        })
        .strict()
        .parse(input);
      await app.runtime.resolveInvocation(
        args.runId,
        args.invocationId,
        args.result,
        args.succeeded,
      );
      return { resolved: true };
    }
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
