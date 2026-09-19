import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { cleanup, configDirectory, output, ScriptedProvider, temporary } from './helpers.js';

it('отказ записи завершает исполнителя, виден во всех списках и требует восстановления', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const directory = join(root, 'state');
  const workspace = join(root, 'workspace');
  let broken = false;
  const provider = new ScriptedProvider(() => {
    broken = true;
    return output('Ответ модели');
  });
  const app = await createApplication(config, directory, provider);
  cleanup(() => app.close());
  const mutate = app.sessions.mutate.bind(app.sessions);
  const fault = vi.spyOn(app.sessions, 'mutate').mockImplementation((...args) => {
    if (broken) return Promise.reject(new Error('ENOSPC: тестовый отказ диска'));
    return mutate(...args);
  });
  const { runId } = await app.runtime.start({
    message: 'Проверь сохранение',
    workspace,
    requestKey: 'disk-failure',
  });
  await expect(app.runtime.wait(runId)).rejects.toThrow('ENOSPC');
  await expect(app.runtime.wait(runId)).rejects.toThrow('ENOSPC');
  expect(app.runtime.busy()).toBe(false);
  expect(app.sessions.get(runId).status).toBe('running');
  const status = await dispatch(app, 'runtime.status', { runId, waitMs: 25000 });
  expect(status).toMatchObject({
    status: 'paused',
    recoveryRequired: true,
    approvals: [],
    error: expect.stringContaining('Не удалось сохранить'),
  });
  expect(await dispatch(app, 'runtime.task', { runId })).toMatchObject(status as object);
  expect(await dispatch(app, 'runtime.list', {})).toMatchObject([{ status: 'paused' }]);
  expect(await dispatch(app, 'runtime.history', {})).toMatchObject({
    active: [{ status: 'paused' }],
  });
  expect(await dispatch(app, 'system.info', {})).toMatchObject({
    activeRuns: 0,
    pendingApprovals: 0,
    recoveryError: expect.stringContaining('ENOSPC'),
  });
  // Даже если место освободилось, старый процесс не возобновляет работу поверх неопределённого журнала.
  broken = false;
  fault.mockRestore();
  await expect(app.runtime.resume(runId)).rejects.toThrow('закройте Harness');
  await expect(
    app.runtime.start({ message: 'Другой запрос', workspace, requestKey: 'new-after-failure' }),
  ).rejects.toThrow('закройте Harness');
  await expect(
    app.runtime.sendMessage({ runId, message: 'Уточнение', requestKey: 'message-after-failure' }),
  ).rejects.toThrow('закройте Harness');
  const journal = await readFile(join(directory, 'runs', runId + '.jsonl'), 'utf8');
  expect(JSON.parse(journal.trim().split('\n').at(-1)!).state.status).toBe('running');
  await app.close();
  const recovered = await createApplication(
    config,
    directory,
    new ScriptedProvider(() => output('Восстановлено')),
  );
  cleanup(() => recovered.close());
  expect(await dispatch(recovered, 'runtime.status', { runId })).toMatchObject({
    status: 'paused',
    recoveryRequired: undefined,
  });
  await recovered.runtime.resume(runId);
  await recovered.runtime.wait(runId);
  expect(recovered.sessions.get(runId)).toMatchObject({
    status: 'completed',
    result: 'Восстановлено',
  });
});
