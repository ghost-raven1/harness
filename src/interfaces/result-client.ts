import type { CliContext, StatusView } from './types.js';
import type { ResultPage } from './result-pages.js';

/** Дочитывает именно выбранный запуск; пустая или изменившаяся страница не маскируется под полный ответ. */
export async function completeResult(
  context: Pick<CliContext, 'request'>,
  status: StatusView,
): Promise<StatusView> {
  if (!status.resultTruncated) return status;
  const chunks: string[] = [];
  let cursor = 0;
  const total = status.resultLength;
  while (true) {
    const page = await context.request<ResultPage>('runtime.result', {
      runId: status.runId,
      cursor,
    });
    if (
      page.cursor !== cursor ||
      page.total !== total ||
      page.nextCursor !== cursor + page.text.length
    )
      throw new Error('Ответ изменился во время чтения. Откройте его заново.');
    chunks.push(page.text);
    if (!page.hasMore) {
      if (page.nextCursor !== total)
        throw new Error('Не удалось дочитать полный ответ. Повторите чтение.');
      return { ...status, result: chunks.join(''), resultTruncated: false, resultPage: undefined };
    }
    if (page.nextCursor <= cursor) throw new Error('Сервис не вернул следующую часть ответа.');
    cursor = page.nextCursor;
  }
}
