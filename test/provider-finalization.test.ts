import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SdkModelProvider } from '../src/providers/sdk-provider.js';
import { CodexModelProvider } from '../src/providers/codex/provider.js';
import { CodexConnection } from '../src/providers/codex/connection.js';
import type { ModelRequest } from '../src/providers/types.js';
import { mapPrompt } from '../src/providers/prompt.js';
import { fixtureConfig, temporary } from './helpers.js';
function input(provider: 'anthropic' | 'codex'): ModelRequest {
  return {
    profile: { ...fixtureConfig('/tmp').profiles.test!, provider, retries: 0 },
    messages: [{ role: 'user', content: 'Покажи состояние' }],
    tools: [
      {
        name: 'task.status',
        description: 'Статус',
        effect: 'read',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  };
}
function sse(parts: unknown[]) {
  return new Response(parts.map((part) => 'data: ' + JSON.stringify(part) + '\n\n').join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
it.each([undefined, '', '{broken'])(
  'Anthropic сохраняет завершённые аргументы и ID: delta=%j',
  async (json) => {
    const request = input('anthropic'),
      name = mapPrompt(request).alias('task.status');
    const provider = new SdkModelProvider(1, async () =>
      sse([
        {
          type: 'message_start',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool1', name, input: {} },
        },
        ...(json !== undefined
          ? [
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'input_json_delta', partial_json: json },
              },
            ]
          : []),
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ]),
    );
    expect((await provider.generate(request)).calls).toEqual([
      { id: 'tool1', name: 'task.status', arguments: json || '{}' },
    ]);
  },
);
it.each(['before', 'after'] as const)(
  'Codex сохраняет первичную ошибку протокола: %s raw-complete',
  async (position) => {
    const dir = await temporary(),
      request = input('codex'),
      name = mapPrompt(request).alias('task.status');
    const messages = [
      {
        method: 'rawResponseItem/completed',
        params: {
          threadId: 't1',
          turnId: 'turn1',
          item: { type: 'function_call', call_id: 'c1', name, arguments: '{}' },
        },
      },
      {
        method: 'rawResponse/completed',
        params: {
          threadId: 't1',
          turnId: 'turn1',
          responseId: 'r1',
          usage: {
            inputTokens: 3,
            cachedInputTokens: 0,
            outputTokens: 4,
            reasoningOutputTokens: 0,
            totalTokens: 7,
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 't1',
          turnId: 'turn1',
          item: {
            id: 'builtin1',
            type: 'commandExecution',
            commandActions: [],
            command: 'pwd',
            cwd: '/tmp',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: '/tmp',
          },
        },
      },
      { id: 77, method: 'unsupported/method', params: { threadId: 't1', turnId: 'turn1' } },
    ];
    if (position === 'before') messages.unshift(messages.splice(2, 1)[0]!);
    const path = join(dir, 'server.cjs');
    await writeFile(
      path,
      `const batch=${JSON.stringify(messages)};const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;send({id:r.id,result:r.method==='config/read'?{config:{}}:r.method==='thread/start'?{thread:{id:'t1'}}:{}});if(r.method==='turn/start')process.stdout.write(batch.map(v=>JSON.stringify(v)).join('\\n')+'\\n');});`,
    );
    const provider = new CodexModelProvider(
      (signal) => new CodexConnection(signal, process.execPath, [path]),
    );
    await expect(provider.generate(request)).rejects.toThrow('встроенный исполнитель');
  },
);
