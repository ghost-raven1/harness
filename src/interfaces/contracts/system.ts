import { z } from 'zod';
import { historyVerificationSchema, indexRebuildSchema } from '../../diagnostics/history-types.js';
import { command, count, empty } from './common.js';

export const serviceInfoSchema = z
  .object({
    configFile: z.string().optional(),
    node: z.string(),
    version: z.string(),
    state: z.string(),
    // Отсутствие метаданных допустимо у сервиса протокола 1 до выпуска 0.3.0.
    buildId: z.string().nullable().optional(),
    protocolVersion: count.optional(),
    storageVersion: count.optional(),
    capabilities: z.array(z.string()).optional(),
    workspaces: z.array(z.string()),
    defaultProfile: z.string(),
    tools: z.array(z.string()),
    activeRuns: count.optional(),
    activeProjects: count.optional(),
    projectCount: count.optional(),
    projectsAwaitingDecision: count.optional(),
    recoveryError: z.string().optional(),
    pendingApprovals: count.optional(),
    learningVersion: z.string().optional(),
    knowledgeCount: count.optional(),
    profiles: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        model: z.string(),
        configured: z.boolean(),
        baseUrl: z.string(),
      }),
    ),
  })
  .passthrough();
export const diagnosticStatusSchema = z.object({
  enabled: z.boolean(),
  file: z.string(),
  directory: z.string(),
  maxBytes: count,
  retainedFiles: count,
  error: z.string().optional(),
});
export const systemCommands = {
  'diagnostics.verifyHistory': command(empty, historyVerificationSchema),
  'diagnostics.rebuildIndex': command(empty, indexRebuildSchema),
  'system.info': command(empty, serviceInfoSchema),
  'diagnostics.status': command(empty, diagnosticStatusSchema),
  'diagnostics.configure': command(
    z.object({ enabled: z.boolean() }).strict(),
    diagnosticStatusSchema,
  ),
};
