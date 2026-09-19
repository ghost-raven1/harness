import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createApplication } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import { cleanup, configDirectory, output, ScriptedProvider, temporary } from './helpers.js';

test('список, счётчики и поиск полного ответа используют каталог без чтения переписки', async () => {
  const directory = await temporary();
  const config = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const app = await createApplication(
    config,
    join(directory, 'state'),
    new ScriptedProvider(() => output('Начало ответа. '.repeat(1000) + 'Уникальный хвост ответа')),
  );
  cleanup(() => app.close());
  const { runId } = await app.runtime.start({
    message: 'Обычный заголовок',
    workspace: join(directory, 'workspace'),
    requestKey: 'catalog-menu',
  });
  await app.runtime.wait(runId);
  const load = vi.spyOn(app.sessions, 'load').mockRejectedValue(new Error('Меню прочитало снимок'));
  const get = vi.spyOn(app.sessions, 'get').mockImplementation(() => {
    throw new Error('Меню прочитало переписку');
  });
  const history = vi
    .spyOn(app.sessions, 'history')
    .mockRejectedValue(new Error('Меню прочитало журнал'));
  try {
    expect(await dispatch(app, 'runtime.list', {})).toMatchObject([
      { runId, task: 'Обычный заголовок' },
    ]);
    expect(await dispatch(app, 'system.info', {})).toMatchObject({
      activeRuns: 0,
      pendingApprovals: 0,
    });
    expect(await dispatch(app, 'runtime.history', { query: 'уникальный хвост' })).toMatchObject({
      total: 1,
      items: [{ runId }],
    });
    expect(load).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  } finally {
    load.mockRestore();
    get.mockRestore();
    history.mockRestore();
  }
});

test('повреждение обучения оставляет диагностику доступной и запрещает новые изменения', async () => {
  const directory = await temporary();
  const config = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const state = join(directory, 'state');
  const provider = new ScriptedProvider(() => output('Не должен вызываться'));
  const initial = await createApplication(config, state, provider);
  await initial.close();
  await appendFile(join(state, 'learning.jsonl'), '{"seq":1,"state":{"schemaVersion":999}}\n');
  const app = await createApplication(config, state, provider);
  cleanup(() => app.close());
  expect(await dispatch(app, 'system.info', {})).toMatchObject({
    recoveryError: expect.any(String),
  });
  expect(await dispatch(app, 'runtime.history', {})).toMatchObject({ total: 0 });
  for (const method of [
    'runtime.run',
    'runtime.cancel',
    'runtime.resume',
    'runtime.message',
    'runtime.resolve',
    'runtime.delete',
    'runtime.purge',
    'maintenance.reset',
    'iterations.configure',
    'approvals.decide',
    'files.restore',
    'files.resolveRestore',
    'drafts.create',
    'drafts.update',
    'drafts.rebase',
    'drafts.remove',
    'learning.pause',
    'learning.resume',
    'learning.feedback',
    'learning.rollback',
    'learning.export',
  ]) {
    // Даже устаревшая форма не должна успеть изменить данные перед отказом режима просмотра.
    await expect(dispatch(app, method, {})).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  }
  await expect(app.runtime.setIterationLimit(100)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
  expect(provider.requests).toEqual([]);
});
