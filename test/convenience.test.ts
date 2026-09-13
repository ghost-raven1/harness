import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CredentialStore, type CredentialEntry } from '../src/interfaces/guided/credentials.js';
import { savePreferences, recentProjects } from '../src/interfaces/guided/preferences.js';
import { SessionKeys } from '../src/interfaces/guided/service.js';
import { addProfile } from '../src/configuration/profiles.js';
import { loadConfig } from '../src/configuration/loader.js';
import { queryHistory } from '../src/sessions/history.js';
import {
  configDirectory,
  fixtureConfig,
  harness,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

it('ключ сохраняется только по выбору; разные адреса API не получают чужой ключ', async () => {
  const root = await temporary(),
    profile = { ...fixtureConfig(root).profiles.test!, apiKeyEnv: 'HARNESS_SECRET_TEST' };
  const passwords = new Map<string, string>();
  const factory = vi.fn(
    async (account: string): Promise<CredentialEntry> => ({
      getPassword: async () => passwords.get(account),
      setPassword: async (value) => {
        passwords.set(account, value);
      },
      deletePassword: async () => passwords.delete(account),
    }),
  );
  const vault = new CredentialStore(root, factory);
  expect(await vault.get(profile)).toBeUndefined();
  expect(factory).not.toHaveBeenCalled();
  await vault.save(profile, 'private-fixture-value');
  const reopened = new CredentialStore(root, factory);
  expect(await reopened.get(profile)).toBe('private-fixture-value');
  expect(await reopened.get({ ...profile, baseUrl: 'https://different.test/v1' })).toBeUndefined();
  expect(await readFile(join(root, 'credentials.json'), 'utf8')).not.toContain(
    'private-fixture-value',
  );
  await vault.forget(profile);
  expect(await reopened.get(profile)).toBeUndefined();
  expect(passwords.size).toBe(0);
});
it('ошибка системного хранилища не маскируется под успешное сохранение', async () => {
  const root = await temporary(),
    profile = fixtureConfig(root).profiles.test!;
  const vault = new CredentialStore(root, async () => {
    throw new Error('Хранилище закрыто');
  });
  await expect(vault.save(profile, 'fixture')).rejects.toThrow('закрыто');
  await expect(readFile(join(root, 'credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('ключ текущего окна не переходит на другой адрес того же провайдера', async () => {
  const profile = {
    ...fixtureConfig('/tmp').profiles.test!,
    apiKeyEnv: 'HARNESS_SCOPED_FIXTURE_KEY',
  };
  const keys = new SessionKeys();
  try {
    keys.select(profile);
    keys.set(profile.apiKeyEnv, 'one-service-only');
    keys.select({ ...profile, baseUrl: 'https://different.test/v1' });
    expect(process.env[profile.apiKeyEnv]).toBeUndefined();
  } finally {
    keys.clear();
  }
});
it('недавние проекты не дублируются, переключение модели не меняет авторские правила', async () => {
  const root = await temporary(),
    configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const before = await loadConfig(configFile),
    profile = { ...before.value.profiles.test!, model: 'another-model' };
  const id = await addProfile(configFile, profile),
    after = await loadConfig(configFile);
  expect(after.value.policy).toEqual(before.value.policy);
  expect(after.value.roles).toEqual(before.value.roles);
  expect(after.value.profiles.test).toEqual(before.value.profiles.test);
  expect(after.value.profiles[id]?.model).toBe('another-model');
  expect(await addProfile(configFile, profile)).toBe(id);
  const first = { configFile, workspace: root, profile: 'test' },
    next = { ...first, profile: id };
  await savePreferences(root, first);
  await savePreferences(root, next);
  expect(await recentProjects(root)).toEqual([next]);
});
it('поиск находит старые задачи и ответы, активные задачи закреплены при любом запросе', async () => {
  const app = await harness(new ScriptedProvider(() => output('Старый ответ: иголка')));
  const { runId } = await app.runtime.start({
    message: 'Первая задача',
    workspace: app.workspace,
    requestKey: randomUUID(),
  });
  await app.runtime.wait(runId);
  const base = app.sessions.get(runId);
  const runs = Array.from({ length: 35 }, (_, index) => ({
    ...structuredClone(base),
    id: randomUUID(),
    createdAt: String(index),
    result: index === 0 ? 'Иголка' : 'Обычный ответ',
  }));
  runs[0]!.status = 'running';
  runs[1]!.result = 'Иголка';
  const last = queryHistory(runs, '', 3, 10);
  expect(last.pages).toBe(4);
  expect(last.items).toHaveLength(4);
  expect(last.active[0]?.runId).toBe(runs[0]!.id);
  const found = queryHistory(runs, 'ИГОЛКА', 0, 10);
  expect(found.total).toBe(1);
  expect(found.items[0]?.runId).toBe(runs[1]!.id);
  expect(found.active).toHaveLength(1);
});

it('отмена смены подключения восстанавливает ключ текущей модели', () => {
  const keys = new SessionKeys(),
    first = { ...fixtureConfig('/tmp').profiles.test!, apiKeyEnv: 'HARNESS_CHECKPOINT_KEY' };
  try {
    keys.select(first);
    keys.set(first.apiKeyEnv, 'original-fixture');
    const restore = keys.checkpoint();
    keys.select({ ...first, baseUrl: 'https://different.test' });
    keys.set(first.apiKeyEnv, 'new-fixture');
    restore();
    expect(process.env[first.apiKeyEnv]).toBe('original-fixture');
  } finally {
    keys.clear();
  }
});
