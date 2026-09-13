import { expect, it } from 'vitest';
import { dispatch } from '../src/interfaces/routes.js';
import type { TaskDraft } from '../src/sessions/drafts.js';
import { inputApplication } from './task-input-fixture.js';

it('окна создают разные записи, устаревшая версия не затирает сохранённый текст', async () => {
  const app = await inputApplication();
  const scope = { workspace: app.workspace, profile: 'test' };
  const first = (await dispatch(app, 'drafts.create', {
    scope,
    text: 'Первый\nабзац',
  })) as TaskDraft;
  const other = (await dispatch(app, 'drafts.create', { scope, text: 'Другое окно' })) as TaskDraft;
  expect(first.id).not.toBe(other.id);
  const changes = await Promise.allSettled(
    ['Версия А', 'Версия Б'].map((text) =>
      dispatch(app, 'drafts.update', { id: first.id, expectedRevision: 0, text }),
    ),
  );
  expect(changes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
  expect(changes.filter((item) => item.status === 'rejected')).toHaveLength(1);
  expect(await dispatch(app, 'drafts.get', { id: other.id })).toMatchObject({
    text: 'Другое окно',
  });
});

it('отправленный текст и ключ заморожены, до ACK запись остаётся на диске', async () => {
  const app = await inputApplication();
  const draft = (await dispatch(app, 'drafts.create', {
    scope: { workspace: app.workspace, profile: 'test' },
    text: 'Строка1\nСтрока2',
  })) as TaskDraft;
  const pending = (await dispatch(app, 'drafts.update', {
    id: draft.id,
    expectedRevision: 0,
    state: 'pending',
  })) as TaskDraft;
  expect(pending.requestKey).toBe(draft.requestKey);
  await expect(
    dispatch(app, 'drafts.update', { id: draft.id, expectedRevision: 1, text: 'Другой текст' }),
  ).rejects.toThrow('Запрос уже отправлялся');
  expect(await dispatch(app, 'drafts.get', { id: draft.id })).toMatchObject({
    text: 'Строка1\nСтрока2',
    state: 'pending',
  });
});

it('полное удаление беседы убирает её черновики и новую задачу с потерянным ACK', async () => {
  const app = await inputApplication();
  const scope = { workspace: app.workspace, profile: 'test' };
  const pending = (await dispatch(app, 'drafts.create', {
    scope,
    text: 'Исходный запрос',
  })) as TaskDraft;
  const started = await app.runtime.start({
    ...scope,
    message: pending.text,
    requestKey: pending.requestKey,
  });
  await app.runtime.wait(started.runId);
  const followup = (await dispatch(app, 'drafts.create', {
    scope: { ...scope, sessionId: started.sessionId, expectedParentRunId: started.runId },
    text: 'Ещё вопрос',
  })) as TaskDraft;
  const preview = await app.purge.preview(started.runId);
  await app.purge.purge(started.runId, preview.previewToken);
  await expect(dispatch(app, 'drafts.get', { id: pending.id })).rejects.toThrow('Черновик удалён');
  await expect(
    dispatch(app, 'drafts.get', { id: followup.id, sessionId: started.sessionId }),
  ).rejects.toThrow('Черновик удалён');
  await expect(
    dispatch(app, 'drafts.update', {
      id: followup.id,
      sessionId: started.sessionId,
      expectedRevision: 0,
      text: 'Поздняя запись',
    }),
  ).rejects.toThrow('Черновик удалён');
});

it('общий сброс задач удаляет новые черновики, сброс знаний их сохраняет', async () => {
  const app = await inputApplication();
  const draft = (await dispatch(app, 'drafts.create', {
    scope: { workspace: app.workspace },
    text: 'Черновик без задачи',
  })) as TaskDraft;
  let preview = await app.reset.preview('learning');
  await app.reset.reset('learning', preview.previewToken);
  expect(await dispatch(app, 'drafts.get', { id: draft.id })).toMatchObject({ text: draft.text });
  preview = await app.reset.preview('tasks');
  await app.reset.reset('tasks', preview.previewToken);
  await expect(dispatch(app, 'drafts.get', { id: draft.id })).rejects.toThrow('Черновик удалён');
});
