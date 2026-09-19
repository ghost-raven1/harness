import { z } from 'zod';

/** Закрытый набор причин позволяет передать отчёт без содержимого повреждённых записей. */
export const historyIssueCodeSchema = z.enum([
  'JOURNAL_TORN_TAIL',
  'JOURNAL_INVALID_RECORD',
  'JOURNAL_INVALID_SEQUENCE',
  'STORAGE_VERSION_UNSUPPORTED',
  'STORAGE_UNAVAILABLE',
  'STORAGE_UNSAFE_PATH',
  'HISTORY_INVALID_LINK',
  'INDEX_REBUILD_FAILED',
]);

export const historyIssueSchema = z.object({
  code: historyIssueCodeSchema,
  kind: z.enum(['run', 'output', 'learning', 'project', 'storage']),
  runId: z.string().uuid().optional(),
  record: z.number().int().positive().optional(),
});

export const historyVerificationSchema = z.object({
  checkedAt: z.string().datetime(),
  healthy: z.boolean(),
  readOnly: z.boolean(),
  counts: z.object({
    journals: z.number().int().nonnegative(),
    records: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    outputs: z.number().int().nonnegative(),
    learning: z.number().int().nonnegative(),
    projects: z.number().int().nonnegative().optional(),
    unresolvedOperations: z.number().int().nonnegative(),
  }),
  issues: z.array(historyIssueSchema),
});

export const indexRebuildSchema = z.object({
  checkedAt: z.string().datetime(),
  rebuilt: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  issues: z.array(historyIssueSchema),
});

export type HistoryIssue = z.infer<typeof historyIssueSchema>;
export type HistoryVerificationReport = z.infer<typeof historyVerificationSchema>;
export type IndexRebuildReport = z.infer<typeof indexRebuildSchema>;
