import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SdkModelProvider } from '../src/providers/sdk-provider.js';
import { CodexModelProvider } from '../src/providers/codex/provider.js';
import { CodexConnection } from '../src/providers/codex/connection.js';
import { ProviderError } from '../src/providers/errors.js';
import { codexProviderError, providerLimit, retryAfter } from '../src/providers/rate-limits.js';
import { createApplication } from '../src/interfaces/application.js';
import { runStatus } from '../src/interfaces/routes.js';
import { taskDetails } from '../src/interfaces/guided/task-details.js';
import type { StatusView } from '../src/interfaces/types.js';
import type { ModelRequest } from '../src/providers/types.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  fixtureConfig,
  harness,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

const request = (): ModelRequest => ({
  profile: { ...fixtureConfig('/tmp').profiles.test!, retries: 1 },
  messages: [],
  tools: [],
});
function done(): Response {
  return new Response(
    'data: ' +
      JSON.stringify({
        id: 'done',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'test',
        choices: [{ index: 0, delta: { content: 'Готово' }, finish_reason: 'stop' }],
      }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function failure(code = 'rate_limit_exceeded', status = 429, retry?: string): Response {
  return Response.json(
    { error: { code, message: 'PRIVATE_SENTINEL' } },
    {
      status,
      headers: retry === undefined ? {} : { 'Retry-After': retry },
    },
  );
}

it('SDK уважает Retry-After и выполняет успешный ограниченный повтор', async () => {
  const times: number[] = [];
  const retryEvents: number[] = [];
  const provider = new SdkModelProvider(1, async () => {
    times.push(Date.now());
    return times.length === 1 ? failure('rate_limit_exceeded', 429, '0.35') : done();
  });
  expect(
    (
      await provider.generate({
        ...request(),
        onProgress: (event) => {
          if (event.type === 'retry') retryEvents.push(event.attempt);
        },
      })
    ).text,
  ).toBe('Готово');
  expect(times).toHaveLength(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(330);
  expect(retryEvents).toEqual([2]);
  const date = Date.parse('2026-09-12T00:00:00Z');
  expect(retryAfter({ 'Retry-After': 'Sat, 12 Sep 2026 00:00:02 GMT' }, date)).toBe(
    '2026-09-12T00:00:02.000Z',
  );
  expect(retryAfter({ 'Retry-After': 'broken' }, date)).toBeUndefined();
});

it.each([
  ['rate_limit_exceeded', 429, 3, 'rate_limit'],
  ['insufficient_quota', 429, 1, 'quota'],
  ['insufficient_quota', 402, 1, 'quota'],
] as const)(
  'SDK ограничивает попытки для %s/%s и не раскрывает тело ошибки',
  async (code, status, expected, kind) => {
    let attempts = 0;
    const provider = new SdkModelProvider(1, async () => {
      attempts++;
      return failure(code, status);
    });
    const caught = await provider
      .generate({ ...request(), profile: { ...request().profile, retries: 2 } })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).limit?.kind).toBe(kind);
    expect((caught as Error).message).not.toContain('PRIVATE_SENTINEL');
    expect(attempts).toBe(expected);
  },
);

it('длинный Retry-After сохраняется для паузы без раннего повторного запроса; отмена прерывает короткое ожидание', async () => {
  let attempts = 0;
  const provider = new SdkModelProvider(1, async () => {
    attempts++;
    return failure('rate_limit_exceeded', 429, '120');
  });
  const caught = await provider.generate(request()).catch((error: unknown) => error);
  expect((caught as ProviderError).limit?.retryAt).toBeDefined();
  expect(attempts).toBe(1);
  const controller = new AbortController();
  let cancelledAttempts = 0;
  const cancellable = new SdkModelProvider(1, async () => {
    cancelledAttempts++;
    return failure('rate_limit_exceeded', 429, '10');
  });
  await expect(
    cancellable.generate({
      ...request(),
      signal: controller.signal,
      onProgress: (event) => {
        if (event.type === 'retry') controller.abort();
      },
    }),
  ).rejects.toThrow();
  expect(cancelledAttempts).toBe(1);
});

it.each([400, 401, 403, 404])(
  'обычный HTTP %s не становится ограничением и не повторяется',
  async (status) => {
    let attempts = 0;
    const provider = new SdkModelProvider(1, async () => {
      attempts++;
      return failure('invalid_request', status);
    });
    const error = await provider.generate(request()).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).limit).toBeUndefined();
    expect(attempts).toBe(1);
  },
);

it('не интерпретирует текст ответа/ошибки как структурированный rate limit', async () => {
  expect(
    providerLimit({ message: 'HTTP 429 insufficient_quota rateLimitExceeded' }),
  ).toBeUndefined();
  expect(
    codexProviderError({ message: 'rateLimitExceeded' }, 'Протокольная ошибка').limit,
  ).toBeUndefined();
  const provider = new SdkModelProvider(
    1,
    async () =>
      new Response(
        'data: ' +
          JSON.stringify({
            id: 'text',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                delta: { content: 'HTTP 429 insufficient_quota' },
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  expect((await provider.generate(request())).text).toBe('HTTP 429 insufficient_quota');
});

it('после 429 сохраняет паузу, историю и готовую запись; возобновляет после перезапуска без повтора эффекта', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  let apiCalls = 0;
  const sdk = new SdkModelProvider(1, async () => {
    apiCalls++;
    return failure();
  });
  const source = new ScriptedProvider((request, index) =>
    index === 0
      ? output('', [call('write', 'fs.write', { path: 'saved.txt', content: 'Записано' })])
      : sdk.generate({ ...request, profile: { ...request.profile, retries: 1 } }),
  );
  const app = await createApplication(configFile, join(directory, 'state'), source);
  cleanup(() => app.close());
  const { runId, sessionId } = await app.runtime.start({
    message: 'Проверка',
    workspace: join(directory, 'workspace'),
    requestKey: 'rate-restart',
  });
  await app.runtime.wait(runId);
  const before = app.sessions.get(runId);
  const history = app.sessions.history(runId, 0);
  expect(before).toMatchObject({
    status: 'paused',
    pauseReason: 'provider',
    providerPause: { kind: 'rate_limit' },
  });
  expect(apiCalls).toBe(2);
  const status = (await runStatus(app, runId)) as unknown as StatusView;
  expect(status.pauseReason).toBe('provider');
  expect(status.providerPause).toEqual(before.providerPause);
  const retryAt = '2026-09-30T10:30:00Z';
  expect(
    taskDetails({ ...status, providerPause: { kind: 'rate_limit', retryAt } })[0]!.text,
  ).toContain('Повторить после ' + new Date(retryAt).toLocaleString('ru-RU') + ' (местное время)');
  expect(before.fileChanges).toHaveLength(1);
  await app.close();
  await writeFile(join(directory, 'workspace/saved.txt'), 'Правка человека');
  const restored = await createApplication(
    configFile,
    join(directory, 'state'),
    new ScriptedProvider(() => output('Продолжено')),
  );
  cleanup(() => restored.close());
  expect(restored.sessions.get(runId).providerPause).toEqual(before.providerPause);
  await restored.runtime.resume(runId);
  await restored.runtime.wait(runId);
  const after = restored.sessions.get(runId);
  expect(after).toMatchObject({ id: runId, sessionId, status: 'completed' });
  expect(after.providerPause).toBeUndefined();
  expect(after.pauseReason).toBeUndefined();
  expect(after.config).toEqual(before.config);
  expect(after.learningVersion).toBe(before.learningVersion);
  expect(after.fileChanges).toEqual(before.fileChanges);
  expect(after.invocations).toEqual(before.invocations);
  expect(restored.sessions.history(runId, 0).slice(0, history.length)).toEqual(history);
  expect(await readFile(join(directory, 'workspace/saved.txt'), 'utf8')).toBe('Правка человека');
});

it('возобновление до Retry-After сохраняет задачу без нового запроса', async () => {
  const sdk = new SdkModelProvider(1, async () => failure('rate_limit_exceeded', 429, '120'));
  const app = await harness(sdk);
  const { runId } = await app.runtime.start({
    message: 'Подождать',
    workspace: app.workspace,
    requestKey: 'retry-time',
  });
  await app.runtime.wait(runId);
  const before = app.sessions.get(runId);
  await expect(app.runtime.resume(runId)).rejects.toThrow('просит подождать');
  expect(app.sessions.get(runId)).toEqual(before);
});

it('429 дочерней роли ставит дерево на паузу и сохраняет готового ребёнка при продолжении', async () => {
  let limited = true;
  let readyCalls = 0;
  let app!: Awaited<ReturnType<typeof harness>>;
  const sdk = new SdkModelProvider(1, async () => failure());
  const source = new ScriptedProvider(async (request) => {
    if (request.messages.some((message) => message.content === 'Готовый ребёнок')) {
      readyCalls++;
      return output('Готовый результат ребёнка');
    }
    if (request.messages.some((message) => message.content === 'Ограниченный ребёнок')) {
      if (!limited) return output('Продолженный результат ребёнка');
      await eventually(() =>
        app.sessions
          .list()
          .some((run) =>
            Object.values(run.agents).some((agent) => agent.result === 'Готовый результат ребёнка'),
          ),
      );
      return sdk.generate(request);
    }
    if (!request.messages.some((message) => message.role === 'tool'))
      return output('', [
        call('ready', 'agents.delegate', { role: 'worker', task: 'Готовый ребёнок' }),
        call('limited', 'agents.delegate', { role: 'worker', task: 'Ограниченный ребёнок' }),
      ]);
    return output('Итог родителя');
  });
  app = await harness(source);
  const { runId } = await app.runtime.start({
    message: 'Две ветки',
    workspace: app.workspace,
    requestKey: 'child-rate',
  });
  await app.runtime.wait(runId);
  const before = app.sessions.get(runId);
  expect(before.status).toBe('paused');
  expect(before.providerPause?.kind).toBe('rate_limit');
  expect(
    Object.values(before.agents).find((agent) => agent.result === 'Готовый результат ребёнка')
      ?.status,
  ).toBe('completed');
  limited = false;
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  const after = app.sessions.get(runId);
  expect(after.status).toBe('completed');
  expect(Object.values(after.agents)).toHaveLength(3);
  expect(Object.values(after.agents).every((agent) => agent.status === 'completed')).toBe(true);
  expect(after.agents[after.rootAgentId]!.collectedChildren).toHaveLength(2);
  expect(readyCalls).toBe(1);
  expect(
    after.agents[after.rootAgentId]!.messages.some((message) =>
      message.content.includes('Готовый результат ребёнка'),
    ),
  ).toBe(true);
  expect(Object.values(after.agents).every((agent) => agent.error === undefined)).toBe(true);
});

it.each(['error', 'completed', 'rpc'] as const)(
  'Codex классифицирует %s с codexErrorInfo и делает ограниченный повтор',
  async (event) => {
    const directory = await temporary();
    const path = join(directory, 'server.cjs');
    const counter = join(directory, 'attempts.txt');
    await writeFile(
      path,
      `
const fs = require('node:fs');
const counter = ${JSON.stringify(counter)};
const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
fs.writeFileSync(counter, String(attempt));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  const error = { message: 'PRIVATE_SENTINEL', codexErrorInfo: 'rateLimitExceeded' };
  if (message.method === 'thread/start' && ${JSON.stringify(event)} === 'rpc' && attempt === 1)
    return send({id:message.id,error:{code:-32000,message:'PRIVATE_SENTINEL',data:error}});
  send({id:message.id,result:message.method === 'config/read' ? {config:{}} : message.method === 'thread/start' ? {thread:{id:'t1'}} : {}});
  if (message.method !== 'turn/start') return;
  if (attempt === 1) {
    if (${JSON.stringify(event)} === 'error') send({method:'error',params:{threadId:'t1',turnId:'u1',willRetry:false,error}});
    else send({method:'turn/completed',params:{threadId:'t1',turn:{status:'failed',error}}});
    return;
  }
  send({method:'rawResponse/completed',params:{threadId:'t1',usage:{inputTokens:10,outputTokens:5}}});
  send({method:'item/completed',params:{threadId:'t1',item:{id:'m1',type:'agentMessage',text:'Codex продолжил'}}});
  send({method:'turn/completed',params:{threadId:'t1',turn:{status:'completed'}}});
});
`,
    );
    const provider = new CodexModelProvider(
      (signal) => new CodexConnection(signal, process.execPath, [path]),
    );
    const input = request();
    input.profile.provider = 'codex';
    expect((await provider.generate(input)).text).toBe('Codex продолжил');
    expect(await readFile(counter, 'utf8')).toBe('2');
  },
);

it('Codex распознаёт квоту и HTTP429 по схеме, но не маскирует обычную ошибку401', () => {
  expect(codexProviderError({ codexErrorInfo: 'usageLimitExceeded' }, 'fallback').limit?.kind).toBe(
    'quota',
  );
  expect(
    codexProviderError(
      { codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
      'fallback',
    ).limit?.kind,
  ).toBe('rate_limit');
  expect(
    codexProviderError(
      { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } },
      'fallback',
    ).limit,
  ).toBeUndefined();
});

it.each(['qwen', 'openai', 'anthropic', 'google'] as const)(
  '%s сохраняет структурированное ограничение внутри SSE-потока',
  async (provider) => {
    const error =
      provider === 'anthropic'
        ? { type: 'error', error: { type: 'rate_limit_error', message: 'PRIVATE_SENTINEL' } }
        : provider === 'google'
          ? { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'PRIVATE_SENTINEL' } }
          : {
              error: {
                code: 'rate_limit_exceeded',
                type: 'rate_limit_error',
                message: 'PRIVATE_SENTINEL',
              },
            };
    const sdk = new SdkModelProvider(
      1,
      async () =>
        new Response('data: ' + JSON.stringify(error) + '\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const result = await sdk
      .generate({ ...request(), profile: { ...request().profile, provider, retries: 0 } })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ProviderError);
    expect((result as ProviderError).limit?.kind).toBe('rate_limit');
    expect((result as Error).message).not.toContain('PRIVATE_SENTINEL');
  },
);

it('отмена во время Retry-After завершает дерево отменой и не отправляет следующий запрос', async () => {
  let attempts = 0;
  let waiting = false;
  const sdk = new SdkModelProvider(1, async () => {
    attempts++;
    return failure('rate_limit_exceeded', 429, '10');
  });
  const source = new ScriptedProvider((request) =>
    sdk.generate({
      ...request,
      onProgress(event) {
        request.onProgress?.(event);
        if (event.type === 'retry') waiting = true;
      },
    }),
  );
  const app = await harness(source, (config) => {
    config.profiles.test!.retries = 1;
  });
  const { runId } = await app.runtime.start({
    message: 'Остановить ожидание',
    workspace: app.workspace,
    requestKey: 'cancel-rate-wait',
  });
  await eventually(() => waiting);
  await app.runtime.cancel(runId);
  expect(app.sessions.get(runId).status).toBe('cancelled');
  expect(app.runtime.busy()).toBe(false);
  expect(attempts).toBe(1);
});

it('отказ API401 завершает задачу ошибкой, а не приостановкой по квоте', async () => {
  const sdk = new SdkModelProvider(1, async () => failure('invalid_api_key', 401));
  const app = await harness(sdk);
  const { runId } = await app.runtime.start({
    message: 'Ошибка ключа',
    workspace: app.workspace,
    requestKey: 'api401',
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId)).toMatchObject({ status: 'failed' });
  expect(app.sessions.get(runId).providerPause).toBeUndefined();
  expect(app.sessions.get(runId).error).toContain('401');
});
