import { z } from 'zod';

export const RESULT_PAGE_BYTES = 256 * 1024;
export const resultCursorSchema = z.number().int().nonnegative().safe();
export interface ResultPage {
  text: string;
  cursor: number;
  nextCursor: number;
  total: number;
  hasMore: boolean;
}

/** Курсор измеряется в UTF-16; граница страницы не разделяет суррогатную пару. */
export function textPage(text: string, cursor = 0, maximumBytes = RESULT_PAGE_BYTES): ResultPage {
  if (cursor > text.length) throw new Error('Курсор находится за концом текста.');
  const betweenPair = (index: number): boolean =>
    index > 0 &&
    /[\uD800-\uDBFF]/.test(text[index - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(text[index] ?? '');
  if (betweenPair(cursor))
    throw new Error('Курсор разделяет символ Unicode. Используйте nextCursor.');
  let low = cursor,
    high = Math.min(text.length, cursor + maximumBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(cursor, middle))) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  const nextCursor = betweenPair(low) ? low - 1 : low;
  return {
    text: text.slice(cursor, nextCursor),
    cursor,
    nextCursor,
    total: text.length,
    hasMore: nextCursor < text.length,
  };
}

/** Обычный ответ сохраняет контракт; большой явно содержит только первую страницу. */
export function resultFields(result: string | undefined, cursor?: number) {
  if (result === undefined && cursor === undefined) return { result };
  const first = textPage(result ?? '');
  const page = cursor === undefined || cursor === 0 ? first : textPage(result ?? '', cursor);
  return {
    result: result === undefined ? undefined : first.text,
    ...(first.hasMore ? { resultTruncated: true, resultLength: first.total } : {}),
    ...(first.hasMore || cursor !== undefined ? { resultPage: page } : {}),
  };
}

/** Каталог передаёт короткое описание; исходное сообщение остаётся в статусе задачи. */
export function taskPreview<T extends { task: string }>(item: T): T & { taskTruncated?: boolean } {
  const page = textPage(item.task, 0, 4096);
  return page.hasMore ? { ...item, task: page.text + '…', taskTruncated: true } : item;
}
