import { projectCaptureSchema } from './project-capture.js';
import { z } from 'zod';

export const decisionSchema = z.enum(['allow', 'deny', 'ask']);
const permission = z
  .object({
    tool: z.string(),
    decision: decisionSchema,
    args: z.record(z.string()).default({}),
  })
  .strict();
export const profileSchema = z
  .object({
    provider: z
      .enum(['qwen', 'openai', 'anthropic', 'google', 'openai-compatible', 'codex'])
      .default('qwen'),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z.string().optional(),
    contextTokens: z.number().int().min(1024).default(32768),
    outputTokens: z.number().int().positive().default(2048),
    timeoutMs: z.number().int().positive().default(120000),
    retries: z.number().int().min(0).max(3).default(2),
    options: z.record(z.unknown()).default({}),
  })
  .strict()
  .refine(
    (p) =>
      p.provider !== 'codex' ||
      (p.baseUrl === 'codex://account' &&
        !p.apiKeyEnv &&
        Object.keys(p.options).every((key) => key === 'effort') &&
        (!p.options.effort || typeof p.options.effort === 'string')),
    'Codex uses account login; only the effort option is supported',
  )
  .refine((p) => p.outputTokens < p.contextTokens, 'outputTokens must fit context')
  .refine(
    (p) =>
      !Object.keys(p.options).some((k) =>
        ['model', 'messages', 'tools', 'stream', 'max_tokens'].includes(k),
      ),
    'Profile options cannot replace protocol fields',
  );
const roleSchema = z
  .object({
    prompt: z.string(),
    permissions: z.array(permission),
    modelProfile: z.string().optional(),
    memory: z.array(z.string()).default([]),
  })
  .strict();
const mcpServer = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().url().optional(),
    tokenEnv: z.string().optional(),
    tools: z.record(z.enum(['read', 'write'])).default({}),
  })
  .strict()
  .refine(
    (s) => (s.transport === 'stdio' ? !!s.command : !!s.url),
    'Transport address is required',
  );
export const evaluationCaseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['target', 'holdout']),
    workspace: z.string().optional(),
    role: z.string(),
    profile: z.string().optional(),
    prompt: z.string(),
    tools: z
      .array(
        z
          .object({
            name: z.string(),
            description: z.string(),
            schema: z.record(z.unknown()),
            result: z.unknown(),
            effect: z.enum(['read', 'write']).default('read'),
          })
          .strict(),
      )
      .default([]),
    expect: z
      .object({
        includes: z.array(z.string()).default([]),
        excludes: z.array(z.string()).default([]),
        calls: z
          .array(z.object({ name: z.string(), args: z.record(z.unknown()).optional() }).strict())
          .default([]),
      })
      .strict(),
    maxTurns: z.number().int().min(1).max(10).default(4),
  })
  .strict()
  .refine(
    (test) =>
      test.expect.includes.length + test.expect.excludes.length + test.expect.calls.length > 0,
    'Evaluation requires at least one trusted assertion',
  );
export const learningSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Старые конфиги читаются без миграции; токеновая квота больше не применяется.
    dailyTokens: z.number().int().positive().optional(),
    cases: z.array(evaluationCaseSchema).default([]),
  })
  .strict()
  .refine(
    (value) => new Set(value.cases.map((test) => test.id)).size === value.cases.length,
    'Evaluation case IDs must be unique',
  )
  .refine(
    (value) =>
      !value.cases.some(
        (test) =>
          test.kind === 'holdout' &&
          value.cases.some((other) => other.kind === 'target' && other.prompt === test.prompt),
      ),
    'Held-out prompts must differ from target prompts',
  );
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    basePrompt: z.string(),
    rules: z.array(z.string()),
    workspaces: z.array(z.string()).min(1),
    defaultRole: z.string(),
    coordination: z.enum(['auto', 'manual']).default('auto'),
    defaultProfile: z.string(),
    projects: z
      .object({
        maxCorrections: z.number().int().min(0).max(10).optional(),
        capture: projectCaptureSchema.optional(),
      })
      .strict()
      .optional(),
    profiles: z.record(profileSchema),
    roles: z.record(roleSchema),
    policy: z.object({ default: decisionSchema, rules: z.array(permission) }).strict(),
    tools: z
      .object({
        timeoutMs: z.number().int().positive().default(60000),
        resultBytes: z.number().int().min(256).default(32768),
        deniedPaths: z.array(z.string()).default(['**/.env', '**/.env.*']),
        mcp: z.array(mcpServer).default([]),
      })
      .strict(),
    limits: z
      .object({
        agents: z.number().int().min(1).max(32).default(4),
        depth: z.number().int().min(0).max(8).default(2),
        modelConcurrency: z.number().int().min(1).default(2),
        reads: z.number().int().min(1).default(4),
        turns: z.number().int().positive().safe().default(256),
        // Сохранены только для чтения прежних конфигов и снимков задач.
        runTokens: z.number().int().positive().optional(),
        dailyTokens: z.number().int().positive().optional(),
        handoffs: z.number().int().min(0).default(8),
      })
      .strict()
      .default({}),
    learning: learningSchema,
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Role = Config['roles'][string];
export type PermissionRule = Role['permissions'][number];
export type Decision = z.infer<typeof decisionSchema>;
export type EvaluationCase = z.infer<typeof evaluationCaseSchema>;
export interface ConfigSnapshot {
  hash: string;
  value: Config;
}
