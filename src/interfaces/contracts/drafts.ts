import { z } from 'zod';
import {
  draftLocationSchema,
  draftScopeSchema,
  draftUpdateSchema,
  draftSchema,
  taskTextLimit,
} from '../../sessions/drafts.js';
import { command, count } from './common.js';
import { draftPayloadSchema } from '../../sessions/draft-payload.js';

const summarySchema = draftSchema
  .omit({ text: true, payload: true })
  .extend({ preview: z.string() });

export const draftCommands = {
  'drafts.list': command(
    z.object({ scope: draftScopeSchema, offset: count.default(0) }).strict(),
    z.object({ items: z.array(summarySchema), total: count }),
  ),
  'drafts.get': command(draftLocationSchema, draftSchema),
  'drafts.create': command(
    z
      .object({
        scope: draftScopeSchema,
        text: z.string().max(taskTextLimit).optional(),
        requestKey: z.string().min(1).max(200).optional(),
        payload: draftPayloadSchema.optional(),
        expectedProjectRevision: count.optional(),
      })
      .strict(),
    draftSchema,
  ),
  'drafts.update': command(draftUpdateSchema, draftSchema),
  'drafts.rebase': command(
    draftLocationSchema.extend({ expectedRevision: count, parentRunId: z.string().uuid() }),
    draftSchema,
  ),
  'drafts.remove': command(
    draftLocationSchema.extend({ expectedRevision: count }),
    z.object({ removed: z.literal(true) }),
  ),
};
