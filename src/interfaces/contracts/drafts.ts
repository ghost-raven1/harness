import { z } from 'zod';
import {
  draftLocationSchema,
  draftScopeSchema,
  draftUpdateSchema,
  taskTextLimit,
} from '../../sessions/drafts.js';
import { command, count } from './common.js';

const draftSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  scope: draftScopeSchema,
  requestKey: z.string().min(1).max(200),
  revision: count,
  text: z.string().max(taskTextLimit),
  state: z.enum(['editing', 'pending']),
  expectedProjectRevision: count.optional(),
  updatedAt: z.string(),
});
const summarySchema = draftSchema.omit({ text: true }).extend({ preview: z.string() });

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
