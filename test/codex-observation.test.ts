import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexConnection } from '../src/providers/codex/connection.js';
import { CodexModelProvider } from '../src/providers/codex/provider.js';
import { mapPrompt } from '../src/providers/prompt.js';
import type { JsonObject } from '../src/shared/primitives.js';
import { temporary } from './helpers.js';
import { observationFixture, observedRequest } from './provider-observation-helpers.js';

/** Эфемерный app-server передаёт настоящие RPC и уведомления без внешней модели. */
async function providerFor(messages: JsonObject[]): Promise<CodexModelProvider> {
  const directory = await temporary();
  const path = join(directory, 'server.cjs');
  await writeFile(
    path,
    `
const batch = ${JSON.stringify(messages)};
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  send({id:request.id,result:request.method === 'config/read' ? {config:{}} : request.method === 'thread/start' ? {thread:{id:'t1'}} : {}});
  if (request.method === 'turn/start') process.stdout.write(batch.map(message => JSON.stringify(message)).join('\\n') + '\\n');
});
`,
  );
  return new CodexModelProvider((signal) => new CodexConnection(signal, process.execPath, [path]));
}

/** Привязывает уведомление к единственному эфемерному потоку проверки. */
function event(method: string, params: JsonObject): JsonObject {
  return { method, params: { threadId: 't1', ...params } };
}

const raw = (responseId: string | undefined, inputTokens = 10, outputTokens = 5) =>
  event('rawResponse/completed', {
    ...(responseId ? { responseId } : {}),
    usage: { inputTokens, outputTokens },
  });
const cumulative = (inputTokens = 10, outputTokens = 5) =>
  event('thread/tokenUsage/updated', {
    tokenUsage: { total: { inputTokens, outputTokens } },
  });
const text = () =>
  event('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'Готово' } });
const done = () => event('turn/completed', { turn: { status: 'completed' } });

it.each(['before', 'after', 'duplicate', 'anonymous'] as const)(
  'Codex не складывает повторные raw и cumulative уведомления: %s',
  async (order) => {
    const observed = observationFixture();
    const messages =
      order === 'before'
        ? [cumulative(), raw('r1')]
        : order === 'after'
          ? [raw('r1'), cumulative()]
          : order === 'anonymous'
            ? [raw(undefined), raw(undefined), cumulative()]
            : [cumulative(), raw('r1'), raw('r1'), cumulative(), cumulative(3, 2)];
    const provider = await providerFor([...messages, text(), done()]);
    const output = await provider.generate({
      ...observedRequest(),
      observation: observed.observation,
    });
    expect(output).toMatchObject({
      text: 'Готово',
      usage: { input: 10, output: 5 },
      usageSource: 'provider',
    });
    expect(observed.usages).toEqual([
      { usage: { input: 10, output: 5, source: 'provider' }, details: { attempt: 1 } },
    ]);
    expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
  },
);

it('Codex суммирует разные ответы, сохраняя единый итог и при задержанном cumulative', async () => {
  const observed = observationFixture();
  const provider = await providerFor([
    raw('r1', 10, 5),
    cumulative(10, 5),
    raw('r2', 20, 7),
    raw('r2', 20, 7),
    cumulative(30, 12),
    cumulative(10, 5),
    text(),
    done(),
  ]);
  const output = await provider.generate({
    ...observedRequest(),
    observation: observed.observation,
  });
  expect(output.usage).toEqual({ input: 30, output: 12 });
  expect(observed.usages).toEqual([
    { usage: { input: 30, output: 12, source: 'provider' }, details: { attempt: 1 } },
  ]);
});

it('первый динамический вызов Codex учитывается и без текстовой дельты', async () => {
  const observed = observationFixture();
  const input = observedRequest();
  const provider = await providerFor([
    event('rawResponseItem/completed', {
      item: {
        type: 'function_call',
        name: mapPrompt(input).alias('fs.read'),
        arguments: '{}',
        call_id: 'c1',
      },
    }),
    raw('r1'),
  ]);
  const output = await provider.generate({ ...input, observation: observed.observation });
  expect(output).toMatchObject({ text: '', finish: 'tools' });
  const first = observed.spans.find((span) => span.phase === 'model.first_output')!;
  const request = observed.spans.find((span) => span.phase === 'model.request')!;
  expect(first.outcome).toBe('completed');
  expect(first.ended).toBeLessThan(request.ended!);
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('Codex сохраняет расход неуспешной попытки, полученный до ошибки протокола', async () => {
  const observed = observationFixture();
  const provider = await providerFor([
    raw('r1'),
    event('error', { error: { message: 'PRIVATE', codexErrorInfo: 'unauthorized' } }),
  ]);
  await expect(
    provider.generate({ ...observedRequest(), observation: observed.observation }),
  ).rejects.toThrow();
  expect(observed.usages).toEqual([
    { usage: { input: 10, output: 5, source: 'provider' }, details: { attempt: 1 } },
  ]);
  expect(observed.spans.find((span) => span.phase === 'model.request')?.outcome).toBe('failed');
  expect(observed.spans.find((span) => span.phase === 'model.first_output')?.outcome).toBe(
    'interrupted',
  );
});

it('Codex без usage явно возвращает оценку совместимого расхода', async () => {
  const observed = observationFixture();
  const provider = await providerFor([event('rawResponse/completed', {}), text(), done()]);
  const output = await provider.generate({
    ...observedRequest(),
    observation: observed.observation,
  });
  expect(output.usageSource).toBe('estimate');
  expect(output.usage.input).toBeGreaterThan(0);
  expect(output.usage.output).toBeGreaterThan(0);
  expect(observed.usages).toEqual([
    { usage: { ...output.usage, source: 'estimate' }, details: { attempt: 1 } },
  ]);
});
