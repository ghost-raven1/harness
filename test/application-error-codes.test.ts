import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createApplication } from '../src/application/bootstrap.js';
import { ApplicationError } from '../src/shared/application-error.js';
import { explainError } from '../src/interfaces/guided/errors.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

test('занятое исполнение и неизвестный результат требуют разных действий по стабильному коду', async () => {
  const provider = new ScriptedProvider(
    (request) =>
      new Promise((resolve) => {
        if (request.signal?.aborted) resolve(output('Остановлено'));
        else
          request.signal?.addEventListener('abort', () => resolve(output('Остановлено')), {
            once: true,
          });
      }),
  );
  const app = await harness(provider);
  const run = await app.runtime.start({
    message: 'Долгая задача',
    workspace: app.workspace,
    requestKey: 'busy',
  });
  await eventually(() => provider.requests.length === 1);
  await expect(app.runtime.resume(run.runId)).rejects.toMatchObject({ code: 'TASK_BUSY' });
  await app.runtime.cancel(run.runId);
  await app.sessions.mutate(run.runId, 'test.unknown', {}, (state) => {
    state.status = 'paused';
    state.invocations.unknown = {
      id: 'unknown',
      agentId: state.rootAgentId,
      call: call('write', 'fs.write', { path: 'result.txt', content: 'Проверить вручную' }),
      effect: 'write',
      status: 'unknown',
      startedAt: new Date().toISOString(),
    };
  });
  await expect(app.runtime.resume(run.runId)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  await expect(
    app.runtime.start({
      message: 'Продолжи',
      workspace: app.workspace,
      sessionId: run.sessionId,
      requestKey: 'continuation',
    }),
  ).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
  expect(provider.requests).toHaveLength(1);
});

test('изменившийся состав удаления возвращает STALE_PREVIEW и сохраняет задачу', async () => {
  const directory = await temporary();
  const config = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const app = await createApplication(
    config,
    join(directory, 'state'),
    new ScriptedProvider(() => output('Ответ')),
  );
  cleanup(() => app.close());
  const { runId } = await app.runtime.start({
    message: 'Задача',
    workspace: join(directory, 'workspace'),
    requestKey: 'preview',
  });
  await app.runtime.wait(runId);
  const preview = await app.purge.preview(runId);
  await app.sessions.mutate(runId, 'test.changed', {}, (run) => {
    run.result = 'Уточнённый ответ';
  });
  await expect(app.purge.purge(runId, preview.previewToken)).rejects.toMatchObject({
    code: 'STALE_PREVIEW',
  });
  expect((await app.sessions.load(runId)).result).toBe('Уточнённый ответ');
  expect(
    explainError(new ApplicationError('STALE_PREVIEW', 'Любая техническая формулировка')),
  ).toBe(explainError(new ApplicationError('STALE_PREVIEW', 'Another language')));
  expect(explainError(new ApplicationError('UNKNOWN_OUTCOME', 'x'))).toContain(
    'подтвердите результат проверки',
  );
});
