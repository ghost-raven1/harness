import { open, unlink } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { z } from 'zod';
import { applicationIdentity } from '../shared/identity.js';
import {
  historyVerificationSchema,
  historyIssueSchema,
  indexRebuildSchema,
  type HistoryVerificationReport,
  type IndexRebuildReport,
  type HistoryIssue,
} from './history-types.js';

const identitySchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  buildId: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  protocolVersion: z.number().int().positive(),
  storageVersion: z.number().int().positive(),
});
const checkSchema = z.object({
  id: z.enum(['runtime', 'service', 'configuration', 'model-profile']),
  status: z.enum(['pass', 'warn', 'fail']),
});

export const diagnosticExportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  client: identitySchema,
  service: identitySchema.optional(),
  environment: z.object({
    node: z.string().regex(/^v\d+\.\d+\.\d+$/),
    platform: z.enum([
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd',
    ]),
    arch: z.enum([
      'arm',
      'arm64',
      'ia32',
      'loong64',
      'mips',
      'mipsel',
      'ppc',
      'ppc64',
      'riscv64',
      's390',
      's390x',
      'x64',
    ]),
  }),
  checks: z.array(checkSchema),
  history: historyVerificationSchema
    .extend({
      issues: z.array(historyIssueSchema.omit({ runId: true })),
    })
    .optional(),
  indexes: indexRebuildSchema
    .extend({
      issues: z.array(historyIssueSchema.omit({ runId: true })),
    })
    .optional(),
});

export type DiagnosticExport = z.infer<typeof diagnosticExportSchema>;

/** Идентификаторы нужны человеку локально, но для передачи отчёта достаточно кода и номера записи. */
function publicIssues(issues: HistoryIssue[]): HistoryIssue[] {
  return issues.map(({ code, kind, record }) => ({ code, kind, ...(record ? { record } : {}) }));
}

/** Собирает отчёт по закрытому списку полей; имена профилей, пути и тексты проверок не копируются. */
export function diagnosticExport(
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail' }>,
  options: {
    service?: unknown;
    history?: HistoryVerificationReport;
    indexes?: IndexRebuildReport;
  } = {},
): DiagnosticExport {
  const service = identitySchema.safeParse(options.service);
  return diagnosticExportSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    client: applicationIdentity(),
    ...(service.success ? { service: service.data } : {}),
    environment: { node: process.version, platform: platform(), arch: arch() },
    checks: checks.map((check) => ({
      id:
        check.name === 'Node.js'
          ? 'runtime'
          : check.name === 'Сервис'
            ? 'service'
            : check.name === 'Конфигурация'
              ? 'configuration'
              : 'model-profile',
      status: check.status,
    })),
    ...(options.history
      ? { history: { ...options.history, issues: publicIssues(options.history.issues) } }
      : {}),
    ...(options.indexes
      ? { indexes: { ...options.indexes, issues: publicIssues(options.indexes.issues) } }
      : {}),
  });
}

/** Создаёт отдельный закрытый файл и не перезаписывает уже существующие пользовательские данные. */
export async function writeDiagnosticExport(path: string, report: DiagnosticExport): Promise<void> {
  const content = JSON.stringify(diagnosticExportSchema.parse(report), null, 2) + '\n';
  const file = await open(path, 'wx', 0o600);
  let saved = false;
  try {
    await file.writeFile(content);
    await file.sync();
    saved = true;
  } finally {
    try {
      await file.close();
    } finally {
      if (!saved) await unlink(path).catch(() => undefined);
    }
  }
}
