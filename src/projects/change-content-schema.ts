import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.startsWith('/') &&
      value.split('/').every((part) => part !== '.' && part !== '..' && part !== ''),
  );
export const contentEntrySchema = z
  .object({
    path,
    kind: z.enum(['file', 'symlink']),
    digest,
    executable: z.boolean(),
    content: z
      .object({
        digest,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(4 * 1024 * 1024),
      })
      .strict()
      .optional(),
    unavailableReason: z
      .enum([
        'disabled',
        'policy',
        'symlink',
        'too-large',
        'binary',
        'encoding',
        'project-limit',
        'total-limit',
      ])
      .optional(),
  })
  .strict()
  .refine(
    (entry) => Boolean(entry.content) !== Boolean(entry.unavailableReason),
    'Нужны содержимое или причина его отсутствия',
  )
  .refine(
    (entry) => !entry.content || (entry.kind === 'file' && entry.content.digest === entry.digest),
    'Неверная связь содержимого с файлом',
  );
export const contentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string(),
    createdAt: z.string().datetime(),
    snapshotDigest: digest,
    snapshotRef: z.string(),
    link: z
      .object({
        runId: z.string().min(1),
        changeSetId: z.string().min(1),
        kind: z.literal('after'),
      })
      .strict()
      .optional(),
    entries: z.array(contentEntrySchema).max(50_000),
  })
  .strict();
export type ContentEntry = z.infer<typeof contentEntrySchema>;
export type ContentManifest = z.infer<typeof contentManifestSchema>;
export type ContentUnavailableReason = NonNullable<ContentEntry['unavailableReason']>;
