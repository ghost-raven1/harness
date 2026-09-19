import { z } from 'zod';
import { projectInputs, projectViewSchema } from './schema.js';
import { changeSnapshotSchema, projectChangeSetSchema } from './change-types.js';
export { projectChangeSetSchema, type ProjectChangeSet } from './change-types.js';

const key = z.string().min(1).max(200);
const count = z.number().int().nonnegative().safe();
const pointSchema = changeSnapshotSchema.omit({ ref: true, contentRef: true });
export const changeSetSummarySchema = projectChangeSetSchema
  .omit({ before: true, after: true })
  .extend({ before: pointSchema, after: pointSchema.optional() });
const fileSideSchema = z.object({
  kind: z.enum(['file', 'symlink']),
  digest: z.string(),
  executable: z.boolean(),
  available: z.boolean(),
  reason: z.string().optional(),
});
export const fileChangeSchema = z.object({
  fileId: key,
  path: z.string(),
  kind: z.enum(['added', 'modified', 'deleted']),
  typeChanged: z.boolean(),
  executableChanged: z.boolean(),
  before: fileSideSchema.optional(),
  after: fileSideSchema.optional(),
});
const project = z.object({ projectId: key }).strict();
const interval = project.extend({ changeSetId: key });
const page = { offset: count.default(0), limit: count.min(1).max(100).default(20) };
/** Идентификатор файла разрешается только внутри сохранённого интервала выбранного проекта. */
export const projectChangeInputs = {
  changeSets: project.extend(page),
  changes: interval.extend(page),
  fileChange: interval.extend({
    fileId: key,
    view: z.enum(['diff', 'before', 'after']),
    offset: count.default(0),
  }),
  changeCapture: projectInputs.changeCapture,
};
export const projectChangeOutputs = {
  changeSets: z.object({
    projectId: key,
    revision: count,
    items: z.array(changeSetSummarySchema),
    total: count,
    nextOffset: count.optional(),
  }),
  changes: z.object({
    projectId: key,
    changeSetId: key,
    interval: changeSetSummarySchema.optional(),
    items: z.array(fileChangeSchema),
    total: count,
    nextOffset: count.optional(),
    complete: z.boolean(),
    reason: z.string().optional(),
  }),
  fileChange: z.object({
    projectId: key,
    changeSetId: key,
    fileId: key,
    path: z.string(),
    view: z.enum(['diff', 'before', 'after']),
    state: z.enum(['available', 'unavailable', 'limited']),
    reason: z.string().optional(),
    text: z.string(),
    offset: count,
    nextOffset: count.optional(),
    totalCharacters: count,
    complete: z.boolean(),
  }),
  changeCapture: projectViewSchema,
};
