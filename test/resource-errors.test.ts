import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { serve, rpc } from '../src/interfaces/ipc.js';
import type { FileLearningStore } from '../src/learning/store.js';
import {
  ResourceNotFoundError,
  resourceErrorData,
  resourceErrorFromData,
} from '../src/shared/resource-errors.js';
import { cleanup, configDirectory, eventually, temporary } from './helpers.js';
import { modelServer } from './process-fixture.js';

it('настоящий IPC отличает удалённые задачи и уроки от разрыва соединения', async () => {
  const root = await temporary(),
    directory = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Проверочный ответ' }));
  const service = await serve(await configDirectory(root, api.baseUrl), directory);
  cleanup(() => service.close());
  const { runId } = await rpc<{ runId: string }>(directory, 'runtime.run', {
    message: 'Изолированная проверка',
    workspace: join(root, 'workspace'),
    requestKey: randomUUID(),
  });
  await eventually(() => service.app.sessions.get(runId).status === 'completed');
  const lessonId = randomUUID();
  await (service.app.learning.store as FileLearningStore).update((state) => {
    state.candidates[lessonId] = {
      id: lessonId,
      sourceRunId: runId,
      workspace: join(root, 'workspace'),
      role: 'coordinator',
      profile: 'test',
      title: 'Проверочный урок',
      lesson: 'Сверять результат',
      appliesWhen: 'При проверке',
      evidenceIds: [],
      status: 'candidate',
      fingerprint: 'fixture',
    };
  });
  await expect(rpc(directory, 'runtime.task', { runId })).resolves.toMatchObject({ runId });
  for (const scope of ['tasks', 'learning']) {
    const plan = await rpc<{ previewToken: string }>(directory, 'maintenance.resetPreview', {
      scope,
    });
    await rpc(directory, 'maintenance.reset', { scope, previewToken: plan.previewToken });
  }
  for (const [method, input, resource] of [
    ['runtime.task', { runId }, 'task'],
    ['learning.inspect', { id: lessonId }, 'lesson'],
    ['learning.export', { id: lessonId }, 'lesson'],
  ] as const) {
    const result = await rpc(directory, method, input).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ResourceNotFoundError);
    expect(result).toMatchObject({ code: 'RESOURCE_NOT_FOUND', resource });
  }
  await expect(rpc(directory, 'system.info')).resolves.toHaveProperty('version');
  await service.close();
  const disconnected = await rpc(directory, 'system.info').catch((error: unknown) => error);
  expect(disconnected).not.toBeInstanceOf(ResourceNotFoundError);
});

it('error.data ограничено известным кодом и видом записи без тела исключения', () => {
  const error = Object.assign(new ResourceNotFoundError('lesson'), { secret: 'private-body' });
  expect(resourceErrorData(error)).toEqual({ code: 'RESOURCE_NOT_FOUND', resource: 'lesson' });
  expect(resourceErrorData(new Error('private-body'))).toBeUndefined();
  for (const data of [
    null,
    {},
    { code: 'OTHER', resource: 'lesson' },
    { code: 'RESOURCE_NOT_FOUND', resource: 'private-body' },
  ])
    expect(resourceErrorFromData(data)).toBeUndefined();
});
