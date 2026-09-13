import type { Profile } from '../configuration/schema.js';
import { z } from 'zod';
import { codexAccount } from './codex/account.js';

export interface CatalogModel {
  id: string;
  label: string;
}
const bodySchema = z.object({
  data: z.array(z.object({ id: z.string(), display_name: z.string().optional() })).optional(),
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/** Запрашивает каталог без генерации текста; не передаёт ключ по редиректу и не показывает тело ошибки. */
export async function listModels(
  profile: Pick<Profile, 'baseUrl' | 'provider'>,
  apiKey?: string,
  fetcher: typeof fetch = fetch,
): Promise<CatalogModel[]> {
  if (profile.provider === 'codex') {
    const account = await codexAccount();
    if (!account.loggedIn) throw new Error('Войдите в Codex через мастер подключения Harness.');
    return account.models;
  }
  const url = new URL(profile.baseUrl.replace(/\/$/, '') + '/models');
  if (url.username || url.password || url.search || url.hash)
    throw new Error('Адрес API должен быть без ключей, параметров и паролей.');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('Для удалённого API нужен адрес https://.');
  const headers: Record<string, string> = {};
  if (profile.provider === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
  } else if (profile.provider === 'google') {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    url.searchParams.set('pageSize', '1000');
  } else if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const response = await fetcher(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Model API HTTP ' + response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Сервер вернул пустой список моделей.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1024 * 1024)
        throw new Error('Список моделей слишком большой. Введите название вручную.');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const body = bodySchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const models =
    profile.provider === 'google'
      ? (body.models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
          .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName ?? m.name }))
      : (body.data ?? [])
          .filter((m) => profile.provider !== 'openai' || /^(gpt-|o\d|chatgpt-)/.test(m.id))
          .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
  return [...new Map(models.map((m) => [m.id, m])).values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}
