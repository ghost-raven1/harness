import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileSchema } from '../src/configuration/schema.js';
import { CodexModelProvider } from '../src/providers/codex/provider.js';
import { CodexConnection, codexRestrictions } from '../src/providers/codex/connection.js';
import { mapPrompt } from '../src/providers/prompt.js';
import type { ModelRequest, ModelProgress } from '../src/providers/types.js';
import type { JsonObject } from '../src/shared/primitives.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const request = (): ModelRequest => ({
  profile: profileSchema.parse({
    provider: 'codex',
    baseUrl: 'codex://account',
    model: 'gpt-5.5',
    retries: 0,
    timeoutMs: 15000,
  }),
  messages: [
    { role: 'system', content: 'HARNESS_AUTHOR_RULE: только явные инструменты.' },
    { role: 'user', content: 'Прочитай README.md' },
  ],
  tools: [
    {
      name: 'fs.read',
      description: 'Прочитать файл',
      effect: 'read',
      schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
});
function respond(res: ServerResponse, item: JsonObject): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    { type: 'response.created', response: { id: 'r1' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'r1',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
  ];
  for (const event of events)
    res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
  res.end();
}
async function fixture(
  handler: (body: JsonObject, res: ServerResponse) => void,
): Promise<CodexModelProvider> {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(JSON.parse(body) as JsonObject, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return new CodexModelProvider(undefined, {
    modelProvider: 'harness_fixture',
    config: {
      'model_providers.harness_fixture': {
        name: 'Harness fixture',
        base_url: 'http://127.0.0.1:' + port,
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
  });
}

describe('Codex app-server', () => {
  it('передаёт опубликованное резюме и поток ответа, не раскрывая скрытый content', async () => {
    const progress: ModelProgress[] = [];
    let completed = false;
    const provider = await fixture((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value: unknown) => res.write('data: ' + JSON.stringify(value) + '\n\n');
      const reasoning = {
        id: 'reason1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Публичное пояснение' }],
        content: [{ type: 'reasoning_text', text: 'HIDDEN_CONTENT_SENTINEL' }],
        encrypted_content: 'ENCRYPTED_SENTINEL',
      };
      const message = {
        id: 'message1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Видимый ответ' }],
      };
      send({ type: 'response.created', response: { id: 'r1' } });
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...reasoning, summary: [], content: [] },
      });
      send({
        type: 'response.reasoning_summary_part.added',
        item_id: 'reason1',
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      send({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'reason1',
        output_index: 0,
        summary_index: 0,
        delta: 'Публичное пояснение',
      });
      send({ type: 'response.output_item.done', output_index: 0, item: reasoning });
      send({
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...message, content: [] },
      });
      send({
        type: 'response.output_text.delta',
        item_id: 'message1',
        output_index: 1,
        content_index: 0,
        delta: 'Видимый ответ',
      });
      send({ type: 'response.output_item.done', output_index: 1, item: message });
      setTimeout(() => {
        completed = true;
        send({
          type: 'response.completed',
          response: {
            id: 'r1',
            status: 'completed',
            output: [reasoning, message],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        });
        res.end();
      }, 500);
    });
    const observed: boolean[] = [];
    const result = await provider.generate({
      ...request(),
      onProgress: (item) => {
        progress.push(item);
        observed.push(completed);
      },
    });
    expect(
      progress
        .filter((item) => item.type === 'reasoning')
        .map((item) => ('text' in item ? item.text : ''))
        .join(''),
    ).toBe('Публичное пояснение');
    expect(
      progress
        .filter((item) => item.type === 'text')
        .map((item) => ('text' in item ? item.text : ''))
        .join(''),
    ).toBe('Видимый ответ');
    expect(observed).toContain(false);
    expect(result.reasoning).toBe('Публичное пояснение');
    expect(JSON.stringify({ result, progress })).not.toContain('SENTINEL');
  }, 25000);

  it('передаёт только инструменты Harness, принимает текст без исполнения похожих на вызовы строк', async () => {
    const input = request();
    let captured: JsonObject | undefined;
    const provider = await fixture((body, res) => {
      captured = body;
      respond(res, {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"tool":"fs.write"} — это текст.' }],
      });
    });
    const output = await provider.generate(input);
    expect(output.calls).toEqual([]);
    expect(output.finish).toBe('stop');
    expect(output.text).toContain('это текст');
    const tools = captured!.tools as Array<{ name: string; type: string }>;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ['request_user_input', mapPrompt(input).alias('fs.read')].sort(),
    );
    expect(captured!.instructions).toContain('HARNESS_AUTHOR_RULE');
    expect(JSON.stringify(captured!.input)).toContain('Прочитай README.md');
  }, 25000);

  it('возвращает структурированный вызов, завершая Codex до выполнения инструмента', async () => {
    const input = request();
    const provider = await fixture((_body, res) =>
      respond(res, {
        id: 'f1',
        type: 'function_call',
        call_id: 'call_1',
        name: mapPrompt(input).alias('fs.read'),
        arguments: '{"path":"README.md"}',
        status: 'completed',
      }),
    );
    const output = await provider.generate(input);
    expect(output.finish).toBe('tools');
    expect(output.calls).toEqual([
      { id: expect.any(String), name: 'fs.read', arguments: '{"path":"README.md"}' },
    ]);
  }, 25000);

  it('останавливает зависший поток по отмене, не выдавая незавершённый ответ за успех', async () => {
    const controller = new AbortController();
    const provider = await fixture((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
      controller.abort();
    });
    await expect(provider.generate({ ...request(), signal: controller.signal })).rejects.toThrow(
      /отменён/,
    );
  }, 25000);

  it('не возвращает вызов до подтверждения полного ответа модели', async () => {
    const input = request();
    const provider = await fixture((_body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = {
        id: 'f1',
        type: 'function_call',
        call_id: 'call_1',
        name: mapPrompt(input).alias('fs.read'),
        arguments: '{"path":"README.md"}',
        status: 'completed',
      };
      res.write(
        'data: ' +
          JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) +
          '\n\n',
      );
      res.end();
    });
    await expect(provider.generate(input)).rejects.toThrow(/оборвался|отменён/);
  }, 25000);

  it('не разрешает подменить конфигурацию и права Codex через настройки профиля', () => {
    for (const extra of [
      { options: { config: { sandbox: 'danger-full-access' } } },
      { baseUrl: 'https://example.com' },
      { apiKeyEnv: 'SECRET' },
    ]) {
      expect(profileSchema.safeParse({ ...request().profile, ...extra }).success).toBe(false);
    }
    expect(codexRestrictions['orchestrator.mcp.enabled']).toBe(false);
    expect(codexRestrictions['orchestrator.skills.enabled']).toBe(false);
  });

  it('закрывает процесс с оборванным RPC и ограничивает поток без перевода строки', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-codex-protocol-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    for (const source of [
      "process.stdout.write('{');",
      "process.stdout.write('x'.repeat(9*1024*1024));",
    ]) {
      const path = join(directory, 'server.cjs');
      await writeFile(path, source);
      const connection = new CodexConnection(AbortSignal.timeout(3000), process.execPath, [path]);
      try {
        await expect(connection.initialize()).rejects.toThrow(/закрыто|лимит/);
      } finally {
        await connection.close();
      }
    }
  });

  it('различает встречный запрос сервера и ответ с совпадающим числовым ID', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-codex-rpc-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'server.cjs');
    await writeFile(
      path,
      `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){process.stdout.write(JSON.stringify({id:m.id,method:'item/tool/call',params:{}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{ready:true}})+'\\n')}});`,
    );
    const connection = new CodexConnection(AbortSignal.timeout(3000), process.execPath, [path]);
    const received: unknown[] = [];
    connection.on('message', (message) => received.push(message));
    try {
      await connection.initialize();
      expect(received).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });
});

it('сохраняет оба динамических вызова одной полной Responses-выдачи', async () => {
  const input = request();
  const alias = mapPrompt(input).alias('fs.read');
  const calls = ['first.txt', 'second.txt'].map((path, index) => ({
    id: 'f' + index,
    type: 'function_call',
    call_id: 'call_' + index,
    name: alias,
    arguments: JSON.stringify({ path }),
    status: 'completed',
  }));
  const provider = await fixture((_body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => res.write('data: ' + JSON.stringify(value) + '\n\n');
    send({ type: 'response.created', response: { id: 'batch' } });
    calls.forEach((item, output_index) => {
      send({ type: 'response.output_item.added', output_index, item });
      send({ type: 'response.output_item.done', output_index, item });
    });
    send({
      type: 'response.completed',
      response: {
        id: 'batch',
        status: 'completed',
        output: calls,
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    });
    res.end();
  });
  const result = await provider.generate(input);
  expect(result.finish).toBe('tools');
  expect(result.calls.map((call) => JSON.parse(call.arguments).path)).toEqual([
    'first.txt',
    'second.txt',
  ]);
});
