import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
  stat,
  lstat,
  mkdtemp,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSchema } from './schema.js';
import type { Profile } from './schema.js';
import { loadConfig } from './loader.js';

export interface InitOptions {
  directory: string;
  workspace: string;
  provider: Profile['provider'];
  model: string;
  baseUrl: string;
  apiKeyEnv?: string;
  confirmWrites?: boolean;
}
const templates = fileURLToPath(new URL('../../config/', import.meta.url));

/** Загружает и проверяет шаблоны профилей, добавляя локальный API и аккаунт Codex. */
export async function defaultProfiles(): Promise<Record<string, Profile>> {
  const source = JSON.parse(await readFile(join(templates, 'profiles.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const result = Object.fromEntries(
    Object.entries(source).map(([name, value]) => [name, profileSchema.parse(value)]),
  );
  result['openai-compatible'] = profileSchema.parse({
    provider: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
  });
  result.codex = profileSchema.parse({
    provider: 'codex',
    baseUrl: 'codex://account',
    model: 'default',
    retries: 0,
    outputTokens: 8192,
  });
  return result;
}

/** Создаёт комплект конфигов целиком; существующий каталог не перезаписывается. */
export async function initializeProject(options: InitOptions): Promise<string> {
  const workspace = await realpath(options.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
  const directory = resolve(options.directory);
  try {
    await lstat(directory);
    throw new Error('Конфигурация уже существует: ' + directory + '. Выберите другой каталог.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const profile = profileSchema.parse({
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    ...(options.provider === 'codex' ? { retries: 0, outputTokens: 8192 } : {}),
    ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}),
  });
  await mkdir(dirname(directory), { recursive: true });
  const temporary = await mkdtemp(join(dirname(directory), '.harness-init-'));
  try {
    await cp(templates, temporary, { recursive: true });
    const manifestPath = join(temporary, 'harness.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.workspaces = [workspace];
    manifest.defaultProfile = options.provider;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(
      join(temporary, 'profiles.json'),
      JSON.stringify({ [options.provider]: profile }, null, 2) + '\n',
    );
    if (options.confirmWrites) {
      const policyPath = join(temporary, String(manifest.policy));
      const policy = JSON.parse(await readFile(policyPath, 'utf8')) as { rules: unknown[] };
      policy.rules.push({ tool: 'fs.write', decision: 'ask' });
      await writeFile(policyPath, JSON.stringify(policy, null, 2) + '\n');
    }
    await loadConfig(manifestPath);
    await rename(temporary, directory);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return join(directory, 'harness.json');
}
