import { z } from 'zod';
import { activityEventSchema, runInsightsSchema } from './schema.js';
const count = z.number().int().nonnegative();
const runId = z.object({ runId: z.string().uuid() }).strict();
/** Связывает схему ввода и ответа без зависимости прикладного слоя от транспорта. */
const command = <P extends z.ZodTypeAny, R extends z.ZodTypeAny>(params: P, response: R) => ({
  params,
  response,
});

const projectId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Метрики и журнал доступны только локальному интерфейсу; права MCP не расширяются. */
export const insightCommands = {
  'runtime.insights': command(
    runId
      .extend({
        agentId: z.string().uuid().optional(),
        resultCursor: count.default(0),
        agentOffset: count.default(0),
        agentLimit: count.min(1).max(100).default(50),
      })
      .strict(),
    runInsightsSchema,
  ),
  'runtime.activity': command(
    runId
      .extend({
        cursor: count.default(0),
        limit: count.min(1).max(100).default(100),
        agentId: z.string().uuid().optional(),
      })
      .strict(),
    z.object({
      events: z.array(activityEventSchema),
      cursor: count,
      hasMore: z.boolean(),
      completeness: z.enum(['complete', 'partial', 'unavailable']),
    }),
  ),
  'projects.insights': command(
    z
      .object({ projectId, offset: count.default(0), limit: count.min(1).max(20).default(20) })
      .strict(),
    z.object({
      projectId,
      items: z.array(
        z.object({
          runId: z.string(),
          stageId: z.string().optional(),
          attempt: count.optional(),
          kind: z.string(),
          insights: runInsightsSchema,
        }),
      ),
      total: count,
      offset: count,
    }),
  ),
};
