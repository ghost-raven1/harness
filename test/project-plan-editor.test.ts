import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hash } from '../src/shared/primitives.js';
import { ProjectPlanService } from '../src/projects/plan-service.js';
import { ProjectPlanHistory } from '../src/projects/plan-history.js';
import { comparePlanValues } from '../src/projects/plan-comparison.js';
import { inspectPlan } from '../src/projects/plan-validation.js';
import { replacePlan, validatePlan } from '../src/projects/plans.js';
import { ScriptedProvider, output } from './helpers.js';
import { draftProject, mutation, projectHarness, stagePlan } from './project-helpers.js';

it('валидатор возвращает пути полей, сохраняет буквальный argv и не вызывает модель', async () => {
  let calls = 0;
  const app = await projectHarness(
    new ScriptedProvider(() => {
      calls++;
      return output('Не вызывать');
    }),
  );
  const view = await draftProject(app);
  const service = new ProjectPlanService(app.projects);
  const plan = stagePlan();
  const stage = plan.stages[0]!;
  stage.verification = {
    kind: 'commands',
    checks: [
      {
        id: 'literal',
        title: 'Буквальные аргументы',
        command: process.execPath,
        args: ['two words', '$HOME', '$(touch secret)', '雪🙂', ''],
      },
    ],
  };
  const before = await readFile(
    join(app.sessions.directory, 'project-records', view.projectId + '.jsonl'),
  );
  const valid = await service.validatePlan({
    projectId: view.projectId,
    plan,
    expectedRevision: view.revision,
  });
  expect(valid.valid).toBe(true);
  expect(valid.plan!.stages[0]!.verification).toEqual(stage.verification);
  expect(valid.choices.roles.map((role) => role.id)).toContain('worker');
  expect(valid.choices.tools).toContain('fs.read');
  stage.role = 'missing-role';
  stage.dependsOn = ['missing-stage'];
  stage.requiredTools = ['unavailable-tool'];
  const invalid = await service.validatePlan({ projectId: view.projectId, plan });
  expect(invalid.valid).toBe(false);
  expect(invalid.issues.map((issue) => issue.path)).toEqual(
    expect.arrayContaining([
      ['stages', 0, 'role'],
      ['stages', 0, 'dependsOn', 0],
      ['stages', 0, 'requiredTools', 0],
    ]),
  );
  expect(invalid.plan).toBeUndefined();
  expect(calls).toBe(0);
  expect(app.checkCount()).toBe(0);
  expect(
    await readFile(join(app.sessions.directory, 'project-records', view.projectId + '.jsonl')),
  ).toEqual(before);
  expect((await app.projects.detail({ projectId: view.projectId })).revision).toBe(view.revision);
});

it('проверка графа сообщает цикл, повторные ID и запрет команды до сохранения', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages.push({ ...structuredClone(plan.stages[0]!), id: 'second', dependsOn: ['implement'] });
  plan.stages[0]!.dependsOn = ['second'];
  expect(inspectPlan(plan, app.snapshot, app.registry).issues).toContainEqual(
    expect.objectContaining({ code: 'dependency_cycle' }),
  );
  plan.stages[0]!.dependsOn = [];
  plan.stages[1]!.id = 'implement';
  expect(inspectPlan(plan, app.snapshot, app.registry).issues).toContainEqual(
    expect.objectContaining({ code: 'duplicate_id', path: ['stages', 1, 'id'] }),
  );
  const config = structuredClone(app.snapshot);
  config.value.policy.rules.push({ tool: 'process.exec', decision: 'deny', args: {} });
  expect(inspectPlan(stagePlan(), config, app.registry).issues).toContainEqual(
    expect.objectContaining({
      code: 'denied_command',
      path: ['stages', 0, 'verification', 'checks', 0, 'command'],
    }),
  );
});

it('завершённый этап защищён одним правилом в предварительной проверке и сохранении', async () => {
  const app = await projectHarness();
  let view = await draftProject(app);
  const record = await app.projectStore.get(view.projectId);
  record.stages.implement!.status = 'completed';
  await app.projectStore.save(record, record.revision, 'test.completed', 'Этап подтверждён');
  view = await app.projects.detail({ projectId: view.projectId });
  const service = new ProjectPlanService(app.projects);
  const plan = stagePlan();
  plan.stages[0]!.task = 'Подменить выполненную работу';
  const result = await service.validatePlan({ projectId: view.projectId, plan });
  expect(result.completedStageIds).toEqual(['implement']);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'completed_stage' }));
  await expect(app.projects.editPlan({ ...mutation(view), plan })).rejects.toThrow(
    'Завершённый этап',
  );
  const replacement = stagePlan();
  replacement.stages[0]!.id = 'replacement';
  expect(
    (await service.validatePlan({ projectId: view.projectId, plan: replacement })).issues,
  ).toContainEqual(expect.objectContaining({ code: 'completed_stage' }));
});

it('устаревшая ревизия не разрешает отправку, но оставляет нормализованный черновик для сравнения', async () => {
  const app = await projectHarness();
  const view = await draftProject(app);
  const service = new ProjectPlanService(app.projects);
  const result = await service.validatePlan({
    projectId: view.projectId,
    plan: stagePlan(),
    expectedRevision: view.revision - 1,
  });
  expect(result).toMatchObject({
    valid: false,
    stale: true,
    revision: view.revision,
    plan: stagePlan(),
  });
  const draft = stagePlan();
  draft.stages[0]!.title = '';
  const compared = await service.comparePlans({ projectId: view.projectId, plan: draft });
  expect(compared.basis).toBe('draft');
  expect(compared.changes).toContainEqual(expect.objectContaining({ field: 'title', after: '' }));
  expect((await service.validatePlan({ projectId: view.projectId, plan: draft })).valid).toBe(
    false,
  );
});

it('история и сравнение читают старые JSONL без изменения снимков и восстанавливают индекс', async () => {
  const app = await projectHarness();
  let view = await draftProject(app);
  const service = new ProjectPlanService(app.projects);
  const first = await service.comparePlans({ projectId: view.projectId });
  expect(first.basis).toBe('first');
  expect(first.changes).toContainEqual(
    expect.objectContaining({ kind: 'added', stageId: 'implement' }),
  );
  const plan = stagePlan();
  if (plan.stages[0]!.verification.kind === 'commands')
    plan.stages[0]!.verification.checks[0]!.args = ['--test', 'one literal argument'];
  view = await app.projects.editPlan({ ...mutation(view), plan });
  const source = join(app.sessions.directory, 'project-records', view.projectId + '.jsonl');
  const before = await readFile(source);
  const beforeStat = await stat(source);
  const versions = await service.planVersions({ projectId: view.projectId, limit: 1 });
  expect(versions.total).toBe(2);
  expect(versions.items[0]!.version).toBe(2);
  expect(versions.nextOffset).toBe(1);
  const diff = await service.comparePlans({ projectId: view.projectId });
  expect(diff).toMatchObject({ basis: 'previous', fromVersion: 1, toVersion: 2 });
  expect(diff.changes).toEqual([
    expect.objectContaining({
      stageId: 'implement',
      checkId: 'tests',
      field: 'check.args',
      after: ['--test', 'one literal argument'],
    }),
  ]);
  const indexPath = join(app.sessions.directory, 'project-index', view.projectId + '.plans.json');
  await writeFile(indexPath, '{broken');
  const history = new ProjectPlanHistory(app.sessions.directory);
  expect((await history.read(await app.projectStore.get(view.projectId), 1)).version).toBe(1);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.data.entries[0].offset = 1;
  index.checksum = hash(index.data);
  await writeFile(indexPath, JSON.stringify(index));
  history.forget(view.projectId);
  expect((await history.read(await app.projectStore.get(view.projectId), 1)).version).toBe(1);
  expect(await readFile(source)).toEqual(before);
  expect((await stat(source)).mtimeMs).toBe(beforeStat.mtimeMs);
});

it('сравнение предпочитает последнюю принятую редакцию и сопоставляет этапы по ID', async () => {
  const app = await projectHarness();
  let view = await draftProject(app);
  const record = await app.projectStore.get(view.projectId);
  record.acceptedVersion = 1;
  record.acceptedAt = new Date().toISOString();
  await app.projectStore.save(record, record.revision, 'test.accepted', 'План принят');
  view = await app.projects.detail({ projectId: view.projectId });
  for (const title of ['Редакция 2', 'Редакция 3']) {
    const plan = stagePlan();
    plan.stages[0]!.title = title;
    view = await app.projects.editPlan({ ...mutation(view), plan });
  }
  const service = new ProjectPlanService(app.projects);
  const diff = await service.comparePlans({ projectId: view.projectId });
  expect(diff).toMatchObject({ basis: 'accepted', fromVersion: 1, toVersion: 3 });
  expect((await service.planVersions({ projectId: view.projectId })).items.at(-1)).toMatchObject({
    version: 1,
    accepted: true,
  });
  const before = stagePlan();
  before.stages.push({ ...structuredClone(before.stages[0]!), id: 'other' });
  const after = structuredClone(before);
  after.stages.reverse();
  after.stages[0]!.role = 'reader';
  after.stages[0]!.dependsOn = ['implement'];
  expect(comparePlanValues(before, after).map((change) => change.field)).toEqual([
    'stages.order',
    'role',
    'dependsOn',
  ]);
});

it('старый сохранённый план больше нового лимита черновика остаётся доступен для принятия', async () => {
  const app = await projectHarness();
  let view = await draftProject(app);
  const plan = stagePlan();
  if (plan.stages[0]!.verification.kind === 'commands')
    plan.stages[0]!.verification.checks[0]!.args = Array.from({ length: 62 }, () =>
      'x'.repeat(15000),
    );
  expect(Buffer.byteLength(JSON.stringify(plan))).toBeGreaterThan(900 * 1024);
  expect(Buffer.byteLength(JSON.stringify(plan))).toBeLessThan(1_200_000);
  expect(inspectPlan(plan, app.snapshot, app.registry).issues[0]?.code).toBe('payload_too_large');
  expect(validatePlan(plan, app.snapshot, app.registry, false)).toEqual(plan);
  const record = await app.projectStore.get(view.projectId);
  replacePlan(record, plan);
  await app.projectStore.save(record, record.revision, 'project.plan', 'Историческая редакция 0.4');
  const source = join(app.sessions.directory, 'project-records', view.projectId + '.jsonl');
  const before = await readFile(source);
  view = await app.projects.detail({ projectId: view.projectId });
  const service = new ProjectPlanService(app.projects);
  expect((await service.comparePlans({ projectId: view.projectId })).after).toEqual(plan);
  expect(await readFile(source)).toEqual(before);
  const accepted = await app.projects.acceptPlan({
    ...mutation(view),
    expectedPlanVersion: view.planVersion!,
  });
  expect(accepted.status).toBe('running');
});
