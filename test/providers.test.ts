import { describe, it, expect } from 'vitest';
import { SdkModelProvider } from '../src/providers/sdk-provider.js';
import { mapPrompt } from '../src/providers/prompt.js';
import { fixtureConfig } from './helpers.js';
import type { ModelRequest } from '../src/providers/types.js';

export function sse(...parts: unknown[]): Response {
  return new Response(
    parts
      .map((part) => 'data: ' + (typeof part === 'string' ? part : JSON.stringify(part)) + '\n\n')
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
export function chatChunk(delta: unknown, finish: string | null = null): unknown {
  return {
    id: 'test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
const request = (): ModelRequest => ({
  profile: fixtureConfig('/tmp').profiles.test!,
  messages: [
    { role: 'system', content: 'Правила' },
    { role: 'user', content: 'Прочти' },
  ],
  tools: [
    {
      name: 'fs.read',
      description: 'Чтение',
      effect: 'read',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
});
describe('Библиотечные адаптеры провайдеров', () => {
  it.each(['qwen', 'openai', 'openai-compatible'] as const)(
    '%s: пустой завершённый поток не выдаётся за успешный ответ',
    async (provider) => {
      const input = request();
      input.profile.provider = provider;
      const model = new SdkModelProvider(1, async () =>
        sse(chatChunk({ content: ' \n\t' }), chatChunk({}, 'stop'), '[DONE]'),
      );
      await expect(model.generate(input)).rejects.toThrow('пустой ответ');
    },
  );

  it.each(['qwen', 'openai', 'openai-compatible'] as const)(
    '%s: текст, вызов, usage и имена инструментов',
    async (provider) => {
      const input = request();
      input.profile.provider = provider;
      let sent: unknown;
      const alias = mapPrompt(input).alias('fs.read');
      const model = new SdkModelProvider(2, async (_, options) => {
        sent = JSON.parse(String(options?.body));
        return sse(
          chatChunk({ content: 'Читаю' }),
          chatChunk({
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: alias, arguments: '{"path":' },
              },
            ],
          }),
          chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
          chatChunk({}, 'tool_calls'),
          '[DONE]',
        );
      });
      const result = await model.generate(input);
      expect(result.text).toBe('Читаю');
      expect(result.finish).toBe('tools');
      expect(result.calls).toEqual([{ id: 'c1', name: 'fs.read', arguments: '{"path":"a"}' }]);
      expect(sent).toMatchObject({ tools: [{ function: { name: alias } }] });
      expect(Number.isFinite(result.usage.input)).toBe(true);
    },
  );
  it('возвращает неверный JSON аргументов для самокоррекции, не теряя ID', async () => {
    const input = request(),
      alias = mapPrompt(input).alias('fs.read');
    const model = new SdkModelProvider(1, async () =>
      sse(
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: 'bad',
              type: 'function',
              function: { name: alias, arguments: '{broken' },
            },
          ],
        }),
        chatChunk({}, 'tool_calls'),
        '[DONE]',
      ),
    );
    expect((await model.generate(input)).calls[0]?.arguments).toBe('{broken');
  });
  it('обрыв потока не считается успехом', async () => {
    const model = new SdkModelProvider(1, async () => sse(chatChunk({ content: 'Не закончено' })));
    await expect(model.generate(request())).rejects.toThrow(/Incomplete/);
  });
  it('повторяет только ограниченное число запросов и скрывает тело ошибки API', async () => {
    let attempts = 0;
    const input = request();
    input.profile.retries = 1;
    const model = new SdkModelProvider(1, async () => {
      attempts++;
      return new Response('private-key', { status: 503 });
    });
    await expect(model.generate(input)).rejects.toThrow('Model API HTTP 503');
    expect(attempts).toBe(2);
  });
  it('Anthropic: обрабатывает нативные события content_block и stop_reason', async () => {
    const input = request();
    input.profile.provider = 'anthropic';
    input.profile.model = 'claude-test';
    let sent: unknown;
    const model = new SdkModelProvider(1, async (_, options) => {
      sent = JSON.parse(String(options?.body));
      return sse(
        {
          type: 'message_start',
          message: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Антропик работает' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 4 },
        },
        { type: 'message_stop' },
      );
    });
    const result = await model.generate(input);
    expect(result.text).toBe('Антропик работает');
    expect(result.usage).toEqual({ input: 3, output: 4 });
    expect(sent).toMatchObject({
      system: expect.anything(),
      tools: [{ input_schema: expect.anything() }],
    });
  });
  it('Google: обрабатывает нативные candidates и functionCall', async () => {
    const input = request();
    input.profile.provider = 'google';
    input.profile.model = 'gemini-test';
    const alias = mapPrompt(input).alias('fs.read');
    let sent: unknown;
    const model = new SdkModelProvider(1, async (_, options) => {
      sent = JSON.parse(String(options?.body));
      return sse({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'Гугл работает' },
                { functionCall: { name: alias, args: { path: 'a' } } },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
      });
    });
    const result = await model.generate(input);
    expect(result.text).toBe('Гугл работает');
    expect(result.calls[0]?.name).toBe('fs.read');
    expect(JSON.parse(result.calls[0]!.arguments)).toEqual({ path: 'a' });
    expect(sent).toMatchObject({ tools: { functionDeclarations: [{ name: alias }] } });
  });
});

it('обрывает сырой SSE без разделителей до накопления неограниченного буфера', async () => {
  const { limitedFetch } = await import('../src/providers/limited-fetch.js');
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = limitedFetch(async () => new Response(source), 2048);
  const response = await fetcher('https://example.test');
  await expect(response.text()).rejects.toThrow('лимит размера');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(cancelled).toBe(true);
});
