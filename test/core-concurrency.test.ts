import { expect, it } from 'vitest';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { commandClient, serve } from '../src/interfaces/ipc.js';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';
import { cleanup, configDirectory, eventually, temporary } from './helpers.js';
import { alias, modelServer, type ApiBody, type ApiAnswer } from './process-fixture.js';

/** Барьер удерживает конкретный переход, не полагаясь на задержки файловой системы или сети. */
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/** Два клиента открывают независимые IPC-соединения с настоящим владельцем временной истории. */
async function fixture(
  answer: (body: ApiBody) => ApiAnswer | Promise<ApiAnswer>,
  effect: (workspace: string) => Promise<unknown>,
  decision: 'allow' | 'ask' = 'allow',
) {
  const root = await temporary();
  const api = await modelServer(answer);
  const config = await configDirectory(root, api.baseUrl);
  await writeFile(
    join(dirname(config), 'policy.json'),
    JSON.stringify({ default: 'deny', rules: [{ tool: 'fixture.write', decision }] }),
  );
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace');
  const service = await serve(config, directory);
  cleanup(() => service.close());
  service.app.registry.register({
    definition: {
      name: 'fixture.write',
      description: 'Проверяемая однократная запись',
      effect: 'write',
      schema: { type: 'object', additionalProperties: false },
    },
    execute: () => effect(workspace),
  });
  return {
    service,
    directory,
    workspace,
    config,
    api,
    first: commandClient(() => directory),
    second: commandClient(() => directory),
  };
}

/** Все модели стенда запрашивают запись один раз и завершаются по сохранённому результату. */
function writeRequest(body: ApiBody): ApiAnswer {
  return { calls: [{ id: 'write-once', name: alias(body, 'fixture.write'), args: {} }] };
}

it('два окна принимают разрешение и одинаковое уточнение однократно', async () => {
  const hold = barrier();
  let writes = 0;
  const env = await fixture(
    (body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'Проверено с уточнением' }
        : writeRequest(body),
    async (workspace) => {
      await appendFile(join(workspace, 'effect.txt'), 'эффект\n');
      writes++;
      await hold.wait;
      return { saved: true };
    },
    'ask',
  );
  cleanup(async () => hold.release());
  const { runId } = await env.first('runtime.run', {
    message: 'Запиши один раз',
    workspace: env.workspace,
    requestKey: 'approval-race',
  });
  await eventually(async () => (await env.first('approvals.list')).length === 1);
  const [approval] = await env.second('approvals.list');
  const decisions = Promise.allSettled([
    env.first('approvals.decide', { approvalId: approval!.id, allow: true }),
    env.second('approvals.decide', { approvalId: approval!.id, allow: true }),
  ]);
  const message = { runId, message: 'Учти дополнительное условие', requestKey: 'same-message' };
  const receipts = await Promise.all([
    env.first('runtime.message', message),
    env.second('runtime.message', message),
  ]);
  expect(receipts[0]).toEqual(receipts[1]);
  const results = await decisions;
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'STALE_PREVIEW' },
  });
  hold.release();
  await env.service.app.runtime.wait(runId);
  const run = await env.service.app.sessions.load(runId);
  expect(run.status).toBe('completed');
  expect(run.userMessages).toHaveLength(1);
  expect(run.userMessages![0]!.deliveredAt).toBeTruthy();
  expect(
    run.agents[run.rootAgentId]!.messages.filter((item) => item.content === message.message),
  ).toHaveLength(1);
  expect(Object.values(run.approvals).map((item) => item.status)).toEqual(['consumed']);
  expect(writes).toBe(1);
  expect(await readFile(join(env.workspace, 'effect.txt'), 'utf8')).toBe('эффект\n');
});

it('гонка продолжения, сообщения и удаления не повторяет подтверждённую запись после паузы и рестарта', async () => {
  const hold = barrier();
  let writes = 0;
  const env = await fixture(
    async (body) => {
      if (!body.messages.some((message) => message.role === 'tool')) return writeRequest(body);
      await hold.wait;
      return { text: 'Продолжено с сохранённым результатом' };
    },
    async (workspace) => {
      await appendFile(join(workspace, 'effect.txt'), 'эффект\n');
      writes++;
      return { saved: true };
    },
  );
  cleanup(async () => hold.release());
  await env.first('iterations.configure', { limit: 1 });
  const input = {
    message: 'Запиши и продолжи',
    workspace: env.workspace,
    requestKey: 'resume-race',
  };
  const { runId } = await env.first('runtime.run', input);
  await env.service.app.runtime.wait(runId);
  expect(await env.second('runtime.status', { runId })).toMatchObject({
    status: 'paused',
    pauseReason: 'iterations',
  });
  await env.second('iterations.configure', { runId, limit: 3, expectedLimit: 1 });
  const resumes = Promise.allSettled([
    env.first('runtime.resume', { runId }),
    env.second('runtime.resume', { runId }),
  ]);
  const message = {
    runId,
    message: 'Проверь дополнительное условие',
    requestKey: 'resume-message',
  };
  const receipts = Promise.all([
    env.first('runtime.message', message),
    env.second('runtime.message', message),
  ]);
  const deletion = env.second('runtime.delete', { runId }).catch((error: unknown) => error);
  expect(await deletion).toMatchObject({ code: 'TASK_BUSY' });
  const results = await resumes;
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejectedResume = results.find((result) => result.status === 'rejected');
  expect(rejectedResume).toMatchObject({
    reason: { code: expect.stringMatching(/^(TASK_BUSY|STALE_PREVIEW)$/) },
  });
  const delivered = await receipts;
  expect(delivered[0]).toEqual(delivered[1]);
  hold.release();
  await env.service.app.runtime.wait(runId);
  expect(await env.first('runtime.status', { runId })).toMatchObject({
    status: 'completed',
    pendingMessages: 0,
  });
  expect(writes).toBe(1);
  expect(
    (await env.service.app.sessions.history(runId, 0)).filter(
      (event) => event.type === 'tool.started',
    ),
  ).toHaveLength(1);
  await env.service.close();
  const restarted = await serve(env.config, env.directory);
  cleanup(() => restarted.close());
  const repeated = await env.second('runtime.run', input);
  expect(repeated.runId).toBe(runId);
  expect(await env.first('runtime.status', { runId })).toMatchObject({
    status: 'completed',
    pendingMessages: 0,
  });
  expect(await readFile(join(env.workspace, 'effect.txt'), 'utf8')).toBe('эффект\n');
});

it('два клиента не возобновляют неизвестный эффект до проверки человеком', async () => {
  const hold = barrier();
  let writes = 0;
  const env = await fixture(
    async (body) => {
      if (!body.messages.some((message) => message.role === 'tool')) return writeRequest(body);
      await hold.wait;
      return { text: 'Проверенный эффект сохранён' };
    },
    async (workspace) => {
      await appendFile(join(workspace, 'effect.txt'), 'эффект\n');
      writes++;
      throw new ToolOutcomeUnknownError('Ответ внешней записи потерялся после выполнения');
    },
  );
  cleanup(async () => hold.release());
  const { runId } = await env.first('runtime.run', {
    message: 'Проверь неизвестный результат',
    workspace: env.workspace,
    requestKey: 'unknown-race',
  });
  await env.service.app.runtime.wait(runId);
  const paused = await env.second('runtime.status', { runId });
  expect(paused.status).toBe('paused');
  expect(paused.unknownInvocations).toHaveLength(1);
  const rejected = await Promise.allSettled([
    env.first('runtime.resume', { runId }),
    env.second('runtime.resume', { runId }),
  ]);
  expect(rejected).toEqual([
    expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }),
    }),
    expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'UNKNOWN_OUTCOME' }),
    }),
  ]);
  const preview = await env.first('runtime.purgePreview', { runId });
  await expect(
    env.second('runtime.purge', { runId, previewToken: preview.previewToken }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  const resolution = {
    runId,
    invocationId: paused.unknownInvocations[0]!.id,
    succeeded: true,
    result: 'Файл проверен человеком: эффект выполнен один раз',
  };
  const resolutions = await Promise.allSettled([
    env.first('runtime.resolve', resolution),
    env.second('runtime.resolve', resolution),
  ]);
  expect(resolutions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await env.first('runtime.resume', { runId });
  hold.release();
  await env.service.app.runtime.wait(runId);
  expect(await env.second('runtime.status', { runId })).toMatchObject({
    status: 'completed',
    unknownInvocations: [],
  });
  expect(writes).toBe(1);
  expect(await readFile(join(env.workspace, 'effect.txt'), 'utf8')).toBe('эффект\n');
});

it('отмена одновременно с разрешением и удалением не теряет исход и не запускает эффект повторно', async () => {
  const hold = barrier();
  let writes = 0;
  const env = await fixture(
    (body) =>
      body.messages.some((message) => message.role === 'tool')
        ? { text: 'Готово' }
        : writeRequest(body),
    async (workspace) => {
      await appendFile(join(workspace, 'effect.txt'), 'эффект\n');
      writes++;
      await hold.wait;
      return { saved: true };
    },
    'ask',
  );
  cleanup(async () => hold.release());
  const input = {
    message: 'Проверка одновременной отмены',
    workspace: env.workspace,
    requestKey: 'cancel-race',
  };
  const { runId } = await env.first('runtime.run', input);
  await eventually(async () => (await env.second('approvals.list')).length === 1);
  const [approval] = await env.first('approvals.list');
  const unsafe = await env.first('runtime.purgePreview', { runId });
  await expect(
    env.second('runtime.purge', { runId, previewToken: unsafe.previewToken }),
  ).rejects.toMatchObject({ code: 'TASK_BUSY' });
  const competing = Promise.allSettled([
    env.first('runtime.cancel', { runId }),
    env.second('approvals.decide', { approvalId: approval!.id, allow: true }),
    env.second('runtime.resume', { runId }),
    env.first('runtime.message', {
      runId,
      message: 'Уточнение рядом с отменой',
      requestKey: 'cancel-message',
    }),
    env.second('runtime.delete', { runId }),
  ]);
  await eventually(
    async () => (await env.first('runtime.status', { runId })).status === 'cancelled',
  );
  hold.release();
  const outcomes = await competing;
  expect(outcomes[0]!.status).toBe('fulfilled');
  const status = await env.second('runtime.status', { runId });
  expect(status.status).toBe('cancelled');
  expect(writes).toBeLessThanOrEqual(1);
  const run = await env.service.app.sessions.load(runId);
  expect(run.userMessages?.length ?? 0).toBe(outcomes[3]!.status === 'fulfilled' ? 1 : 0);
  for (const invocation of status.unknownInvocations)
    await env.first('runtime.resolve', {
      runId,
      invocationId: invocation.id,
      succeeded: true,
      result: 'Проверено после отмены',
    });
  const preview = await env.first('runtime.purgePreview', { runId });
  expect(preview.available).toBe(true);
  const removed = await Promise.all([
    env.first('runtime.purge', { runId, previewToken: preview.previewToken }),
    env.second('runtime.purge', { runId, previewToken: preview.previewToken }),
  ]);
  expect(removed[0]).toEqual(removed[1]);
  await expect(env.first('runtime.status', { runId })).rejects.toMatchObject({
    code: 'RESOURCE_NOT_FOUND',
  });
  await expect(env.second('runtime.run', input)).rejects.toThrow('удалена навсегда');
  expect(env.service.app.runtime.busy()).toBe(false);
  expect(writes).toBeLessThanOrEqual(1);
});
