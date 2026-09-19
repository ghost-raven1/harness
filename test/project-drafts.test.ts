import { expect, it } from 'vitest';
import { dispatch } from '../src/application/commands/index.js';
import { inputApplication } from './task-input-fixture.js';

it('черновики этапов изолированы, pending сохраняет ревизию и запрещает её подмену', async () => {
  const app = await inputApplication();
  const project = await app.projects.create({
    title: 'Проект',
    goal: 'Цель',
    workspace: app.workspace,
    profile: 'test',
    requestKey: 'draft-project',
  });
  const scope = {
    workspace: app.workspace,
    profile: 'test',
    purpose: 'project.plan' as const,
    projectId: project.projectId,
  };
  const first = await app.drafts.create(scope, 'Уточнить план');
  const pending = await app.drafts.update({
    id: first.id,
    expectedRevision: 0,
    state: 'pending',
    expectedProjectRevision: 11,
  });
  expect(pending.expectedProjectRevision).toBe(11);
  await expect(
    app.drafts.update({ id: first.id, expectedRevision: 1, expectedProjectRevision: 12 }),
  ).rejects.toThrow('Запрос уже отправлялся');
  expect((await app.drafts.list({ workspace: app.workspace, profile: 'test' })).total).toBe(0);
  expect((await app.drafts.list(scope)).total).toBe(1);
  await expect(
    dispatch(app, 'drafts.create', { scope: { ...scope, workspace: '/unrelated' } }),
  ).rejects.toThrow('не соответствует');
  await expect(
    dispatch(app, 'drafts.create', {
      scope: { ...scope, purpose: 'project.message', stageId: 'missing' },
    }),
  ).rejects.toThrow('не соответствует');
});

it('проектное назначение нельзя смешать с обычной беседой', async () => {
  const app = await inputApplication();
  await expect(
    app.drafts.create({ workspace: app.workspace, purpose: 'project.message' }),
  ).rejects.toThrow('Черновик проекта');
  await expect(
    app.drafts.create({ workspace: app.workspace, purpose: 'project.goal', stageId: 'foreign' }),
  ).rejects.toThrow('Черновик проекта');
});
