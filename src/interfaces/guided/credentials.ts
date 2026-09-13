import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Profile } from '../../configuration/schema.js';
import { hash } from '../../shared/primitives.js';
import { atomicJson } from '../../sessions/files.js';
import { privateDirectory } from '../local-channel.js';

export const connectionId = (profile: Profile): string =>
  hash({ provider: profile.provider, baseUrl: profile.baseUrl, env: profile.apiKeyEnv });
export interface CredentialEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type CredentialFactory = (account: string) => Promise<CredentialEntry>;
const nativeEntry: CredentialFactory = async (account) => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const entry = new AsyncEntry('Modular Harness', account);
  return {
    getPassword: async () => (await entry.getPassword()) ?? undefined,
    setPassword: (value) => entry.setPassword(value),
    deletePassword: () => entry.deletePassword(),
  };
};

/** Обращается только к явно сохранённым ключам Harness; JSON содержит лишь идентификаторы. */
export class CredentialStore {
  constructor(
    private readonly directory: string,
    private readonly entry: CredentialFactory = nativeEntry,
  ) {}
  private account(profile: Profile): string {
    return hash(resolve(this.directory)) + ':' + connectionId(profile);
  }
  private async enrolled(): Promise<string[]> {
    try {
      return z
        .array(z.string())
        .parse(JSON.parse(await readFile(join(this.directory, 'credentials.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async get(profile: Profile): Promise<string | undefined> {
    const account = this.account(profile);
    if (!(await this.enrolled()).includes(account)) return undefined;
    return (await this.entry(account)).getPassword();
  }
  async save(profile: Profile, value: string): Promise<void> {
    await privateDirectory(this.directory);
    const accounts = await this.enrolled(),
      account = this.account(profile);
    await (await this.entry(account)).setPassword(value);
    await atomicJson(join(this.directory, 'credentials.json'), [
      ...new Set([...accounts, account]),
    ]);
  }
  async forget(profile: Profile): Promise<void> {
    const accounts = await this.enrolled(),
      account = this.account(profile);
    if (!accounts.includes(account)) return;
    await (await this.entry(account)).deletePassword();
    await atomicJson(
      join(this.directory, 'credentials.json'),
      accounts.filter((id) => id !== account),
    );
  }
}
