import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './loader.js';
import { profileSchema, type Profile } from './schema.js';
import { atomicJson } from '../sessions/files.js';
import { hash } from '../shared/primitives.js';

/** Добавляет самостоятельный профиль; прежние роли, политики и область опыта сохраняются. */
export async function addProfile(configFile: string, profile: Profile): Promise<string> {
  await loadConfig(configFile);
  const manifest = z
    .object({ profiles: z.string() })
    .parse(JSON.parse(await readFile(configFile, 'utf8')));
  const path = resolve(dirname(configFile), manifest.profiles);
  const profiles = z.record(profileSchema).parse(JSON.parse(await readFile(path, 'utf8')));
  const validated = profileSchema.parse(profile);
  const id = profile.provider + '-' + hash(validated).slice(0, 12);
  profiles[id] = validated;
  await atomicJson(path, profiles);
  return id;
}
