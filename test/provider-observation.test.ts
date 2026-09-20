import { afterEach, expect, it, vi } from 'vitest';
import { SdkModelProvider } from '../src/providers/sdk-provider.js';
import { ProviderRouter } from '../src/providers/router.js';
import { mapPrompt } from '../src/providers/prompt.js';
import {
  observationFixture,
  observedRequest,
  observedResponse,
} from './provider-observation-helpers.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['qwen', 'openai', 'openai-compatible'] as const)(
  '%s: вызов без текста закрывает первый фрагмент; подтверждённый ноль отличается от неизвестного',
  async (provider) => {
    const input = observedRequest();
    input.profile.provider = provider;
    const observed = observationFixture();
    input.observation = observed.observation;
    const model = new SdkModelProvider(1, async () =>
      observedResponse(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call1',
              type: 'function',
              function: { name: mapPrompt(input).alias('fs.read'), arguments: '{}' },
            },
          ],
        },
        { prompt_tokens: 9, completion_tokens: 0 },
        'tool_calls',
      ),
    );
    const output = await model.generate(input);
    expect(output).toMatchObject({
      text: '',
      finish: 'tools',
      usage: { input: 9, output: 0 },
      usageSource: 'provider',
    });
    expect(observed.usages).toEqual([
      { usage: { input: 9, output: 0, source: 'provider' }, details: { attempt: 1 } },
    ]);
    const queue = observed.spans.find((span) => span.phase === 'model.queue')!;
    const request = observed.spans.find((span) => span.phase === 'model.request')!;
    const first = observed.spans.find((span) => span.phase === 'model.first_output')!;
    expect(queue.ended).toBeLessThan(request.started);
    expect(first.outcome).toBe('completed');
    expect(first.ended).toBeLessThan(request.ended!);
    expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
  },
);

it('успешный ответ без usage помечает совместимую оценку, а не расход провайдера', async () => {
  const observed = observationFixture();
  const provider = new SdkModelProvider(1, async () => observedResponse());
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

it('опубликованное пояснение закрывает первый фрагмент до последующего текста', async () => {
  const observed = observationFixture();
  const seen: Array<[string, string | undefined]> = [];
  const provider = new SdkModelProvider(1, async () =>
    observedResponse({ reasoning_content: 'Проверю условие', content: 'Готово' }),
  );
  await provider.generate({
    ...observedRequest(),
    observation: observed.observation,
    onProgress: (event) => {
      seen.push([
        event.type,
        observed.spans.find((span) => span.phase === 'model.first_output')?.outcome,
      ]);
    },
  });
  expect(seen).toEqual([
    ['reasoning', 'completed'],
    ['text', 'completed'],
  ]);
  expect(observed.spans.filter((span) => span.phase === 'model.first_output')).toHaveLength(1);
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('отказ до первого фрагмента сохраняет неизвестный расход nullable', async () => {
  const observed = observationFixture();
  const provider = new SdkModelProvider(1, async () => new Response('private', { status: 401 }));
  await expect(
    provider.generate({ ...observedRequest(), observation: observed.observation }),
  ).rejects.toThrow('401');
  expect(observed.usages).toEqual([
    { usage: { input: null, output: null, source: 'unavailable' }, details: { attempt: 1 } },
  ]);
  expect(observed.spans.find((span) => span.phase === 'model.request')?.outcome).toBe('failed');
  expect(observed.spans.find((span) => span.phase === 'model.first_output')?.outcome).toBe(
    'interrupted',
  );
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('каждая попытка имеет свой расход, а задержка повтора не входит в запрос', async () => {
  const observed = observationFixture();
  let calls = 0;
  const input = observedRequest();
  input.profile.retries = 1;
  const provider = new SdkModelProvider(1, async () =>
    ++calls === 1
      ? new Response('', { status: 503 })
      : observedResponse(undefined, { prompt_tokens: 3, completion_tokens: 5 }),
  );
  await provider.generate({ ...input, observation: observed.observation });
  expect(calls).toBe(2);
  const requests = observed.spans.filter((span) => span.phase === 'model.request');
  expect(requests.map((span) => [span.details?.attempt, span.outcome])).toEqual([
    [1, 'failed'],
    [2, 'completed'],
  ]);
  const retry = observed.spans.find((span) => span.phase === 'model.retry')!;
  expect(retry.started).toBeGreaterThan(requests[0]!.ended!);
  expect(retry.ended).toBeLessThan(requests[1]!.started);
  expect(observed.usages.map((entry) => [entry.details?.attempt, entry.usage.source])).toEqual([
    [1, 'unavailable'],
    [2, 'provider'],
  ]);
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('отмена в Retry-After закрывает ожидание и не начинает новую попытку', async () => {
  const observed = observationFixture();
  const controller = new AbortController();
  const input = observedRequest();
  input.profile.retries = 1;
  let calls = 0;
  const provider = new SdkModelProvider(1, async () => {
    calls++;
    return new Response('', { status: 503 });
  });
  await expect(
    provider.generate({
      ...input,
      signal: controller.signal,
      observation: observed.observation,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(observed.spans.find((span) => span.phase === 'model.retry')?.outcome).toBe('cancelled');
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('отмена после первого фрагмента закрывает попытку без выдуманного расхода', async () => {
  const observed = observationFixture();
  const controller = new AbortController();
  const provider = new SdkModelProvider(1, async () => observedResponse());
  await expect(
    provider.generate({
      ...observedRequest(),
      signal: controller.signal,
      observation: observed.observation,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(observed.spans.find((span) => span.phase === 'model.request')?.outcome).toBe('cancelled');
  expect(observed.spans.find((span) => span.phase === 'model.first_output')?.outcome).toBe(
    'completed',
  );
  expect(observed.usages).toEqual([
    { usage: { input: null, output: null, source: 'unavailable' }, details: { attempt: 1 } },
  ]);
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('пустые дельты не выдают первый фрагмент и не маскируют обрыв потока', async () => {
  const observed = observationFixture();
  const chunk = {
    id: 'r1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
  };
  const provider = new SdkModelProvider(
    1,
    async () =>
      new Response('data: ' + JSON.stringify(chunk) + '\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  await expect(
    provider.generate({ ...observedRequest(), observation: observed.observation }),
  ).rejects.toThrow();
  expect(observed.spans.find((span) => span.phase === 'model.first_output')?.outcome).toBe(
    'interrupted',
  );
  expect(observed.spans.find((span) => span.phase === 'model.request')?.outcome).toBe('failed');
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});

it('отмена в очереди SDK не создаёт попытку или нулевое потребление модели', async () => {
  const observed = observationFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = new SdkModelProvider(1, async () => {
    entered();
    await gate;
    return observedResponse();
  });
  const first = provider.generate(observedRequest());
  await started;
  const controller = new AbortController();
  const second = provider.generate({
    ...observedRequest(),
    signal: controller.signal,
    observation: observed.observation,
  });
  try {
    controller.abort();
    await expect(second).rejects.toThrow();
    expect(observed.spans).toHaveLength(1);
    expect(observed.spans[0]).toMatchObject({
      phase: 'model.queue',
      outcome: 'cancelled',
      ends: 1,
    });
    expect(observed.usages).toEqual([]);
  } finally {
    release();
    await first;
  }
});

it('Router и SDK измеряют последовательные очереди, не считая один интервал дважды', async () => {
  const observed = observationFixture();
  vi.stubGlobal('fetch', async () => observedResponse());
  const router = new ProviderRouter(1);
  await router.generate({ ...observedRequest(), observation: observed.observation });
  const queues = observed.spans.filter((span) => span.phase === 'model.queue');
  expect(queues).toHaveLength(2);
  expect(queues[0]!.ended).toBeLessThan(queues[1]!.started);
  const request = observed.spans.find((span) => span.phase === 'model.request')!;
  expect(queues[1]!.ended).toBeLessThan(request.started);
  expect(observed.usages).toHaveLength(1);
  expect(observed.spans.every((span) => span.ends === 1)).toBe(true);
});
