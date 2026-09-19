import { expect, it } from 'vitest';
import { DraftStore } from '../src/sessions/drafts.js';
import { dispatch } from '../src/application/commands/index.js';
import { inputApplication } from './task-input-fixture.js';
import { stagePlan } from './project-helpers.js';

it('параметры первого запуска переживают перезапуск и замораживаются целиком при подтверждении', async () => {
  const app = await inputApplication();
  const scope = { purpose: 'project.create' as const, workspace: app.workspace, profile: 'test' };
  const payload = {
    kind: 'project.create' as const,
    title: '',
    goal: '',
    workspace: app.workspace,
    profile: 'test',
  };
  const draft = await app.drafts.create(scope, '', 'stable-request', payload);
  expect(draft.state).toBe('editing');
  const edited = await app.drafts.update({
    id: draft.id,
    expectedRevision: 0,
    payload: { ...payload, title: 'Новый проект', goal: 'Создать приложение' },
  });
  const reopened = await new DraftStore(app.sessions).get({ id: draft.id });
  expect(reopened.payload).toEqual(edited.payload);
  const pending = await app.drafts.update({
    id: draft.id,
    expectedRevision: edited.revision,
    state: 'pending',
  });
  expect(pending.requestKey).toBe('stable-request');
  await expect(
    app.drafts.update({
      id: draft.id,
      expectedRevision: pending.revision,
      payload: { ...payload, goal: 'Подменённая цель' },
    }),
  ).rejects.toThrow('Запрос уже отправлялся');
  expect((await app.drafts.get({ id: draft.id })).payload).toEqual(edited.payload);
  expect(app.sessions.catalog(true)).toHaveLength(0);
  expect(app.projects.store.catalog()).toHaveLength(0);
});

it('формы сохраняют неполные этапы, конфликт второго окна не уничтожает черновик', async () => {
  const app = await inputApplication();
  const project = await app.projects.create({
    title: 'Редактор',
    goal: 'Цель',
    workspace: app.workspace,
    profile: 'test',
    requestKey: 'editor-project',
  });
  const scope = {
    purpose: 'project.edit' as const,
    workspace: app.workspace,
    profile: 'test',
    projectId: project.projectId,
  };
  const plan = stagePlan();
  plan.stages[0]!.title = '';
  plan.stages[0]!.task = '';
  plan.stages[0]!.verification = {
    kind: 'commands',
    checks: [{ id: '', title: '', command: '', args: ['a literal arg'] }],
  };
  const draft = await app.drafts.create(
    scope,
    '',
    'editor-request',
    { kind: 'project.edit', plan },
    project.revision,
  );
  const edited = await app.drafts.update({
    id: draft.id,
    expectedRevision: 0,
    payload: { kind: 'project.edit', plan: { ...plan, stages: [] } },
  });
  await expect(
    app.drafts.update({
      id: draft.id,
      expectedRevision: 0,
      payload: { kind: 'project.edit', plan },
    }),
  ).rejects.toThrow('другом окне');
  expect((await app.drafts.get({ id: draft.id })).payload).toEqual(edited.payload);
  const summary = (await app.drafts.list(scope)).items[0]!;
  expect(summary).not.toHaveProperty('payload');
  const pending = await app.drafts.update({
    id: draft.id,
    expectedRevision: edited.revision,
    state: 'pending',
  });
  await expect(
    app.drafts.update({
      id: draft.id,
      expectedRevision: pending.revision,
      expectedProjectRevision: project.revision + 1,
    }),
  ).rejects.toThrow('Запрос уже отправлялся');
});

it('контракт черновиков принимает typed payload и не смешивает назначения', async () => {
  const app = await inputApplication();
  const payload = {
    kind: 'project.create' as const,
    title: 'Проект',
    goal: 'Цель',
    workspace: app.workspace,
    profile: 'test',
  };
  const draft = await dispatch(app, 'drafts.create', {
    scope: { workspace: app.workspace, purpose: 'project.create', profile: 'test' },
    payload,
  });
  expect(draft).toMatchObject({ payload, state: 'editing' });
  await expect(
    app.drafts.create({ workspace: app.workspace }, '', undefined, payload),
  ).rejects.toThrow('назначению');
});

it('слишком большой UTF-8 payload не может превратиться в непередаваемый pending запрос', async () => {
  const app = await inputApplication();
  const project = await app.projects.create({
    title: 'Размер',
    goal: 'Цель',
    workspace: app.workspace,
    profile: 'test',
    requestKey: 'size-project',
  });
  const scope = {
    purpose: 'project.edit' as const,
    workspace: app.workspace,
    profile: 'test',
    projectId: project.projectId,
  };
  const draft = await app.drafts.create(
    scope,
    '',
    undefined,
    { kind: 'project.edit', plan: stagePlan() },
    project.revision,
  );
  const plan = stagePlan();
  plan.stages = Array.from({ length: 16 }, (_, i) => ({
    ...structuredClone(plan.stages[0]!),
    id: 'stage-' + i,
    task: '界'.repeat(32000),
  }));
  await expect(
    app.drafts.update({
      id: draft.id,
      expectedRevision: 0,
      state: 'pending',
      payload: { kind: 'project.edit', plan },
    }),
  ).rejects.toThrow('900 КиБ');
  expect(await app.drafts.get({ id: draft.id })).toMatchObject({ state: 'editing', revision: 0 });
});
