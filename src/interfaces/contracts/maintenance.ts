import { z } from 'zod';
import {
  command,
  count,
  runId,
  optionalRunId,
  digest,
  empty,
  approvalSchema,
  iterationsSchema,
  budgetSchema,
} from './common.js';

const scope = z.enum(['tasks', 'learning', 'all']);
const preview = { available: z.boolean(), blockers: z.array(z.string()), previewToken: digest };
const counts = {
  artifacts: count,
  backups: count,
  lessons: count,
  evidence: count,
  exports: count,
};
const purgePreview = z.object({
  ...preview,
  ...counts,
  sessionId: z.string(),
  runIds: z.array(z.string()),
  runs: count,
});
const resetPreview = z.object({
  ...preview,
  ...counts,
  scope,
  tasks: count,
  projects: count.default(0),
  sessions: count,
  jobs: count,
});
const selection = z.object({ runId: z.string().uuid(), changeId: z.string().uuid() }).strict();
const filePreview = z.object({
  path: z.string(),
  previewToken: digest,
  diff: z.string(),
  next: count.optional(),
});
const restore = selection.extend({ previewToken: z.string().length(64) });

export const maintenanceCommands = {
  'runtime.purgePreview': command(runId, purgePreview),
  'runtime.purge': command(
    runId.extend({ previewToken: digest }),
    z.object({ purged: z.literal(true), sessionId: z.string(), runs: count }),
  ),
  'maintenance.resetPreview': command(z.object({ scope }).strict(), resetPreview),
  'maintenance.reset': command(
    z.object({ scope, previewToken: digest }).strict(),
    z.object({ reset: z.literal(true), scope, tasks: count, sessions: count }),
  ),
  'iterations.status': command(optionalRunId, iterationsSchema),
  'iterations.configure': command(
    optionalRunId.extend({ limit: count.min(1), expectedLimit: count.min(1).optional() }),
    iterationsSchema,
  ),
  'budget.status': command(optionalRunId, budgetSchema),
  'approvals.list': command(empty, z.array(approvalSchema)),
  'approvals.decide': command(
    z
      .object({
        approvalId: z.string().uuid(),
        allow: z.boolean(),
        previewToken: z.string().length(64).optional(),
      })
      .strict(),
    z.object({ decided: z.literal(true) }),
  ),
  'files.preview': command(
    z.object({ approvalId: z.string().uuid(), offset: count.default(0) }).strict(),
    filePreview,
  ),
  'files.previewRestore': command(selection.extend({ offset: count.default(0) }), filePreview),
  'files.previewResolution': command(
    selection,
    z.object({
      path: z.string(),
      outcome: z.enum(['restored', 'applied', 'reviewed']),
      description: z.string(),
      exists: z.boolean(),
      bytes: count,
      currentHash: digest,
      previewToken: digest,
    }),
  ),
  'files.restore': command(restore, z.object({ restored: z.literal(true) })),
  'files.resolveRestore': command(
    restore.extend({ result: z.string().trim().min(1).max(10000) }),
    z.object({ resolved: z.literal(true) }),
  ),
};
