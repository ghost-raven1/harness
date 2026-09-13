import { z } from 'zod';
import { CodexConnection } from './connection.js';

const modelsSchema = z.object({
  data: z.array(z.object({ model: z.string(), displayName: z.string(), isDefault: z.boolean() })),
  nextCursor: z.string().nullable().optional(),
});

/** Читает состояние официального входа и каталог без генерации и без чтения токенов приложением. */
export async function codexAccount(): Promise<{
  loggedIn: boolean;
  models: Array<{ id: string; label: string; isDefault: boolean }>;
}> {
  const connection = new CodexConnection(AbortSignal.timeout(30000));
  try {
    await connection.initialize();
    const account = z
      .object({ account: z.unknown().nullable() })
      .parse(await connection.call('account/read', { refreshToken: false }));
    if (!account.account) return { loggedIn: false, models: [] };
    const models: Array<{ id: string; label: string; isDefault: boolean }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = modelsSchema.parse(
        await connection.call('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      models.push(
        ...result.data.map((model) => ({
          id: model.model,
          label: model.displayName,
          isDefault: model.isDefault,
        })),
      );
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return { loggedIn: true, models };
  } finally {
    await connection.close();
  }
}
