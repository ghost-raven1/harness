import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createApplication } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import { parseCommandInput, parseCommandResponse } from '../src/interfaces/contracts/index.js';
import { cleanup, configDirectory, ScriptedProvider, temporary } from './helpers.js';
import { mutation, stagePlan } from './project-helpers.js';

/** Настоящая сборка приложения с запретом сети и модели для команд редактирования. */
async function fixture() {
  const root = await temporary();
  const configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  await writeFile(
    join(dirname(configFile), 'policy.json'),
    JSON.stringify({ default: 'deny', rules: [{ tool: '*', decision: 'allow' }] }),
  );
  const provider = new ScriptedProvider(() => {
    throw new Error('Редактор не должен вызывать модель');
  });
  const app = await createApplication(configFile, join(root, 'state'), provider);
  cleanup(() => app.close());
  const view = await app.projects.create({
    title: 'Контракт',
    goal: 'Проверка без модели',
    workspace: join(root, 'workspace'),
    profile: 'test',
    requestKey: 'create',
  });
  const plan = stagePlan();
  plan.stages[0]!.role = 'executor';
  return { app, view, plan };
}

it('новые локальные контракты валидируют черновик и историю без изменения источника', async () => {
  const { app, view, plan } = await fixture();
  const path = join(app.directory, 'project-records', view.projectId + '.jsonl');
  const before = await readFile(path);
  const input = parseCommandInput('projects.validatePlan', {
    projectId: view.projectId,
    expectedRevision: view.revision,
    plan,
  });
  const result = parseCommandResponse(
    'projects.validatePlan',
    await dispatch(app, 'projects.validatePlan', input),
  );
  expect(result).toMatchObject({ valid: true, stale: false, revision: view.revision });
  expect(result.plan).toEqual(plan);
  expect(await readFile(path)).toEqual(before);
  const invalid = structuredClone(plan);
  invalid.stages[0]!.role = 'missing';
  const validation = await app.projectPlans.validatePlan({
    projectId: view.projectId,
    plan: invalid,
  });
  expect(validation.issues).toContainEqual(
    expect.objectContaining({ path: ['stages', 0, 'role'] }),
  );
  expect(await readFile(path)).toEqual(before);
  const edited = await app.projects.editPlan({ ...mutation(view), plan });
  const source = await readFile(path);
  const versions = parseCommandResponse(
    'projects.planVersions',
    await dispatch(app, 'projects.planVersions', { projectId: view.projectId }),
  );
  expect(versions.items).toHaveLength(1);
  const compared = parseCommandResponse(
    'projects.comparePlans',
    await dispatch(app, 'projects.comparePlans', { projectId: view.projectId }),
  );
  expect(compared.basis).toBe('first');
  expect(compared.after).toEqual(plan);
  expect(await readFile(path)).toEqual(source);
  const stale = await app.projectPlans.validatePlan({ ...input, expectedRevision: view.revision });
  expect(stale).toMatchObject({ valid: false, stale: true, revision: edited.revision });
  await expect(app.projects.editPlan({ ...mutation(view), plan })).rejects.toMatchObject({
    code: 'PROJECT_CONFLICT',
  });
});

it('сервис объявляет новые возможности, старые поля и протокол остаются совместимыми', async () => {
  // Клиент тоже применяет схему: значение по умолчанию отправило бы неизвестное поле сервису 0.4.0.
  expect(parseCommandInput('projects.list', {})).not.toHaveProperty('attentionOnly');
  const { app, view } = await fixture();
  const info = parseCommandResponse('system.info', await dispatch(app, 'system.info', {}));
  expect(info.protocolVersion).toBe(1);
  expect(info.capabilities).toContain('projects-review-v1');
  const list = parseCommandResponse('projects.list', await dispatch(app, 'projects.list', {}));
  expect(list.items[0]?.projectId).toBe(view.projectId);
  const legacy = {
    ...list,
    attentionCount: undefined,
    items: list.items.map(
      ({
        attention: _a,
        reason: _b,
        reasonCode: _c,
        currentRunId: _d,
        currentStageId: _e,
        ...item
      }) => item,
    ),
  };
  expect(parseCommandResponse('projects.list', legacy).total).toBe(1);
  const review = parseCommandResponse(
    'projects.review',
    await dispatch(app, 'projects.review', { projectId: view.projectId }),
  );
  expect(review.canAccept).toBe(false);
  expect(review.freshness).toBe('not_checked');
  const reports = parseCommandResponse(
    'projects.reports',
    await dispatch(app, 'projects.reports', { projectId: view.projectId }),
  );
  expect(reports.total).toBe(0);
});

it('режим диагностики оставляет чтение и валидацию, но блокирует экспорт и изменения', async () => {
  const { app, view, plan } = await fixture();
  app.sessions.requireRecovery('Тестовый отказ хранения');
  const list = parseCommandResponse('projects.list', await dispatch(app, 'projects.list', {}));
  expect(list.items[0]?.attention?.code).toBe('STORAGE_UNAVAILABLE');
  await expect(
    dispatch(app, 'projects.validatePlan', { projectId: view.projectId, plan }),
  ).resolves.toMatchObject({ valid: true });
  await expect(
    dispatch(app, 'projects.exportPreview', {
      projectId: view.projectId,
      expectedRevision: view.revision,
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  await expect(
    dispatch(app, 'projects.editPlan', { ...mutation(view), plan }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
});
