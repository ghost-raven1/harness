import { projectCaptureSchema } from './project-capture.js';
import { readFile, realpath } from 'node:fs/promises';
import path, { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { configSchema, type ConfigSnapshot } from './schema.js';
import { hash } from '../shared/primitives.js';

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    basePrompt: z.string(),
    rules: z.string(),
    policy: z.string(),
    roles: z.string(),
    profiles: z.string(),
    tools: z.string(),
    learning: z.string(),
    defaultRole: z.string(),
    coordination: z.enum(['auto', 'manual']).optional(),
    defaultProfile: z.string(),
    workspaces: z.array(z.string()),
    limits: z.record(z.number()).optional(),
    projects: z
      .object({
        maxCorrections: z.number().int().min(0).max(10).optional(),
        capture: projectCaptureSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Фиксирует авторские данные заранее, чтобы активный запуск не перечитывал инструкции незаметно. */
export async function loadConfig(file: string): Promise<ConfigSnapshot> {
  const root = dirname(resolve(file));
  const json = async (name: string): Promise<unknown> =>
    JSON.parse(await readFile(resolve(root, name), 'utf8'));
  const manifest = manifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const authoredRoles = z.record(z.record(z.unknown())).parse(await json(manifest.roles));
  for (const role of Object.values(authoredRoles)) {
    role.prompt = await readFile(resolve(root, z.string().parse(role.prompt)), 'utf8');
    role.memory = await Promise.all(
      z
        .array(z.string())
        .parse(role.memory ?? [])
        .map((path) => readFile(resolve(root, path), 'utf8')),
    );
  }
  const value = configSchema.parse({
    schemaVersion: 1,
    basePrompt: await readFile(resolve(root, manifest.basePrompt), 'utf8'),
    rules: await json(manifest.rules),
    policy: await json(manifest.policy),
    roles: authoredRoles,
    profiles: await json(manifest.profiles),
    tools: await json(manifest.tools),
    learning: await json(manifest.learning),
    defaultRole: manifest.defaultRole,
    coordination: manifest.coordination,
    defaultProfile: manifest.defaultProfile,
    limits: manifest.limits,
    ...(manifest.projects ? { projects: manifest.projects } : {}),
    workspaces: await Promise.all(manifest.workspaces.map((path) => realpath(resolve(root, path)))),
  });
  if (!value.roles[value.defaultRole] || !value.profiles[value.defaultProfile])
    throw new Error('Unknown default role/profile');
  for (const role of Object.values(value.roles)) {
    if (role.modelProfile && !value.profiles[role.modelProfile])
      throw new Error('Unknown role model profile');
  }
  for (const test of value.learning.cases) {
    if (!value.roles[test.role] || (test.profile && !value.profiles[test.profile]))
      throw new Error('Unknown evaluation scope');
    if (test.workspace) test.workspace = await realpath(resolve(root, test.workspace));
  }
  return { value, hash: hash(value) };
}
/** Проверяет вложенность путей без обращения к файловой системе и разрешения символических ссылок. */
export function isWithin(root: string, target: string, paths = path): boolean {
  const local = paths.relative(root, target);
  return (
    local === '' ||
    (!local.startsWith('..' + paths.sep) && local !== '..' && !paths.isAbsolute(local))
  );
}
