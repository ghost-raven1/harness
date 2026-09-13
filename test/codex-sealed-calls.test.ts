import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexModelProvider } from '../src/providers/codex/provider.js';
import { CodexConnection } from '../src/providers/codex/connection.js';
import { mapPrompt } from '../src/providers/prompt.js';
import type { ModelRequest } from '../src/providers/types.js';
import { fixtureConfig, temporary } from './helpers.js';

it.each(['model-call-0', 'rpc-call-0', undefined])(
  'поздний RPC не расширяет зафиксированные вызовы модели: callId=%s',
  async (callId) => {
    const directory = await temporary();
    const path = join(directory, 'server.cjs');
    const request: ModelRequest = {
      profile: { ...fixtureConfig(directory).profiles.test!, provider: 'codex', retries: 0 },
      messages: [{ role: 'user', content: 'Две записи' }],
      tools: [
        { name: 'fs.write', description: 'Запись', effect: 'write', schema: { type: 'object' } },
      ],
    };
    const name = mapPrompt(request).alias('fs.write');
    const fields = { threadId: 'thread-1', turnId: 'turn-1' };
    const messages = [
      ...['first.txt', 'second.txt'].map((file, index) => ({
        method: 'rawResponseItem/completed',
        params: {
          ...fields,
          item: {
            type: 'function_call',
            call_id: 'model-call-' + index,
            name,
            arguments: JSON.stringify({ path: file, content: 'Одна запись' }),
          },
        },
      })),
      {
        method: 'rawResponse/completed',
        params: {
          ...fields,
          responseId: 'response-1',
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            totalTokens: 15,
          },
        },
      },
      {
        id: 77,
        method: 'item/tool/call',
        params: {
          ...fields,
          ...(callId ? { callId } : {}),
          namespace: null,
          tool: name,
          arguments: { path: 'first.txt', content: 'Одна запись' },
        },
      },
    ];
    await writeFile(
      path,
      `
const batch = ${JSON.stringify(messages)};
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  send({id:request.id,result:request.method === 'config/read' ? {config:{}} : request.method === 'thread/start' ? {thread:{id:'thread-1'}} : {}});
  if (request.method === 'turn/start') process.stdout.write(batch.map(value => JSON.stringify(value)).join('\\n') + '\\n');
});
`,
    );
    const provider = new CodexModelProvider(
      (signal) => new CodexConnection(signal, process.execPath, [path]),
    );
    const result = await provider.generate(request);
    expect(result.finish).toBe('tools');
    expect(result.calls.map((call) => JSON.parse(call.arguments).path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
    expect(new Set(result.calls.map((call) => call.id)).size).toBe(2);
  },
);
