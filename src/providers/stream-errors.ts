import { limitError, providerLimit } from './rate-limits.js';

/** Сохраняет структурированную SSE-ошибку до того, как SDK отбросит неизвестные поля. */
export function inspectStreamErrors(headers: Headers): (chunk: Uint8Array) => void {
  if (!headers.get('content-type')?.includes('text/event-stream')) return () => undefined;
  const decoder = new TextDecoder();
  const responseHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });
  let buffered = '';
  let data: string[] = [];
  const inspectEvent = (): void => {
    const content = data.join('\n');
    data = [];
    if (!content || content === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(content);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object' || !('error' in event)) return;
    const limit = providerLimit(event, undefined, responseHeaders);
    if (limit) throw limitError(limit);
  };
  return (chunk) => {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      if (!line) inspectEvent();
      else if (line === 'data' || line.startsWith('data:'))
        data.push(line.slice(5).replace(/^ /, ''));
    }
  };
}
