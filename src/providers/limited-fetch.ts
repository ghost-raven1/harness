import { inspectStreamErrors } from './stream-errors.js';

/** Ограничивает сырые ответы до разбора SSE, включая поток без разделителей событий. */
export function limitedFetch(fetcher: typeof fetch, limit = 8 * 1024 * 1024): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    if (!response.body) return response;
    let bytes = 0;
    const inspect = inspectStreamErrors(response.headers);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        /** Проверяет общий размер и ошибки потока до передачи очередного блока парсеру SDK. */
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > limit) throw new Error('Превышен лимит размера ответа API.');
          inspect(chunk);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
