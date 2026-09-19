import { z } from 'zod';

const key = z.string().min(1).max(200);
const count = z.number().int().nonnegative().safe();
export const changeSnapshotSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  ref: z.string(),
  files: count,
  createdAt: z.string(),
  contentRef: z.string().optional(),
});
/** Журнал связывает неизменные точки с интервалом; пробел после аварии не выдаётся за результат. */
export const projectChangeSetSchema = z.object({
  id: key,
  kind: z.enum(['project', 'stage', 'checks', 'external', 'pause']),
  outcome: z.enum(['pending', 'complete', 'gap']),
  before: changeSnapshotSchema,
  after: changeSnapshotSchema.optional(),
  stageId: key.optional(),
  stageTitle: z.string().max(500).optional(),
  attempt: count.optional(),
  runId: key.optional(),
  planVersion: count,
  reportId: key.optional(),
  reason: z.string().optional(),
});
export type ProjectChangeSet = z.infer<typeof projectChangeSetSchema>;
