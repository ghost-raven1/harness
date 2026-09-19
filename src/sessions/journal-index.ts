import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { hash } from '../shared/primitives.js';
import { optionalJson, writeDerivedText } from './files.js';
import { scanJournal } from './journal.js';

const positionSchema = z.object({
  seq: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export const indexSchema = z.object({
  schemaVersion: z.literal(1),
  size: z.number().nonnegative(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  count: z.number().int().nonnegative(),
  lastOffset: z.number().int().nonnegative(),
  positions: z.array(positionSchema),
});
export type JournalIndex = z.infer<typeof indexSchema>;

/** Проверяет производный файл и отпечаток источника; ошибка индекса требует только перестроения. */
export async function readIndex<T>(
  path: string,
  source: string,
  parse: (value: unknown) => T,
): Promise<{ index: JournalIndex; data: T } | undefined> {
  try {
    const stored = z
      .object({ index: indexSchema, data: z.unknown(), checksum: z.string() })
      .parse(await optionalJson(path));
    if (hash({ index: stored.index, data: stored.data }) !== stored.checksum) return undefined;
    const meta = await stat(source);
    if (
      meta.size !== stored.index.size ||
      meta.mtimeMs !== stored.index.mtimeMs ||
      meta.ctimeMs !== stored.index.ctimeMs
    )
      return undefined;
    const positions = stored.index.positions;
    if (stored.index.count === 0) {
      if (meta.size !== 0 || stored.index.lastOffset !== 0) return undefined;
    } else if (
      positions[0]?.offset !== 0 ||
      stored.index.lastOffset >= meta.size ||
      stored.index.lastOffset < (positions.at(-1)?.offset ?? 0)
    )
      return undefined;
    if (
      positions.some(
        (item, i) =>
          item.seq !== i * 128 + 1 ||
          item.offset >= meta.size ||
          (i > 0 && item.offset <= positions[i - 1]!.offset),
      )
    )
      return undefined;
    if (positions.length !== Math.ceil(stored.index.count / 128)) return undefined;
    return { index: stored.index, data: parse(stored.data) };
  } catch {
    return undefined;
  }
}

/** Сохраняет индекс после журнала; отказ вспомогательной записи не отменяет подтверждённый эффект. */
export async function saveIndex(
  path: string,
  index: JournalIndex,
  data: unknown,
  strict = false,
): Promise<void> {
  try {
    const persisted = JSON.parse(JSON.stringify({ index, data })) as {
      index: JournalIndex;
      data: unknown;
    };
    await writeDerivedText(path, JSON.stringify({ ...persisted, checksum: hash(persisted) }));
  } catch (error) {
    if (strict) throw error;
  }
}

/** Строит смещения за один проход, удерживая только последнюю проверенную запись. */
export async function buildIndex<T>(
  source: string,
  validate: (value: unknown, seq: number) => T,
): Promise<{ index: JournalIndex; last?: T }> {
  let last: T | undefined,
    count = 0,
    lastOffset = 0;
  const positions: JournalIndex['positions'] = [];
  for await (const row of scanJournal(source)) {
    last = validate(row.value, ++count);
    if ((count - 1) % 128 === 0) positions.push({ seq: count, offset: row.offset });
    lastOffset = row.offset;
  }
  const meta = await stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { size: 0, mtimeMs: 0, ctimeMs: 0 };
    throw error;
  });
  return {
    index: {
      schemaVersion: 1,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      ctimeMs: meta.ctimeMs,
      count,
      lastOffset,
      positions,
    },
    ...(last === undefined ? {} : { last }),
  };
}

/** Читает страницу с ближайшего разреженного смещения, не загружая предшествующую историю. */
export async function indexedPage<T>(
  source: string,
  index: JournalIndex,
  after: number,
  limit: number,
  validate: (value: unknown, seq: number) => T,
): Promise<T[]> {
  if (after >= index.count || limit <= 0) return [];
  const position = index.positions[Math.floor(after / 128)]!;
  const page: T[] = [];
  let seq = position.seq,
    bytes = 0;
  for await (const row of scanJournal(source, position.offset)) {
    const item = validate(row.value, seq);
    if (seq > after) {
      const size = row.end - row.offset;
      if (page.length && bytes + size > 8 * 1024 * 1024) break;
      page.push(item);
      bytes += size;
    }
    if (++seq > index.count || page.length === limit) break;
  }
  return page;
}

/** Обновляет смещения подтверждённой пачки без повторного чтения источника. */
export async function appendedIndex(
  source: string,
  previous: JournalIndex,
  rows: unknown[],
): Promise<JournalIndex> {
  const positions = [...previous.positions];
  let offset = previous.size,
    count = previous.count,
    lastOffset = previous.lastOffset;
  for (const row of rows) {
    if (count % 128 === 0) positions.push({ seq: count + 1, offset });
    count++;
    lastOffset = offset;
    offset += Buffer.byteLength(JSON.stringify(row) + '\n');
  }
  const meta = await stat(source);
  return {
    schemaVersion: 1,
    size: meta.size,
    mtimeMs: meta.mtimeMs,
    ctimeMs: meta.ctimeMs,
    count,
    lastOffset,
    positions,
  };
}
