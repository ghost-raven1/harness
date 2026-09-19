import { expect, it, vi } from 'vitest';
import { ApplicationError } from '../src/shared/application-error.js';
import { id } from '../src/shared/primitives.js';
import * as journal from '../src/sessions/journal.js';
import {
  projectHarness,
  stagePlan,
  draftProject,
  mutation,
  waitProject,
} from './project-helpers.js';

it('ошибка чтения папки при ручной перепроверке освобождает аренду workspace', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages[0]!.verification = { kind: 'manual', instructions: 'Проверьте ответ' };
  const project = await draftProject(app, plan);
  await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  const paused = await waitProject(app, project.projectId, 'paused');
  expect(app.leases.busy()).toBe(false);
  const failure = vi
    .spyOn(app.coordinator, 'capture')
    .mockRejectedValueOnce(
      new ApplicationError('PROJECT_CHANGED', 'Файл меняется во время чтения'),
    );
  await expect(app.projects.recheck(mutation(paused))).rejects.toMatchObject({
    code: 'PROJECT_CHANGED',
  });
  failure.mockRestore();
  expect(app.leases.busy()).toBe(false);
  const ordinary = await app.runtime.start({
    message: 'Прочитай папку',
    workspace: app.workspace,
    requestKey: id(),
  });
  await app.runtime.wait(ordinary.runId);
});

it('неясный исход записи журнала проекта запрещает повтор до восстановления', async () => {
  const app = await projectHarness();
  const project = await draftProject(app);
  const request = mutation(project);
  const append = journal.appendJournal;
  const uncertain = vi
    .spyOn(journal, 'appendJournal')
    .mockImplementationOnce(async (path, entry) => {
      await append(path, entry);
      throw new Error('EIO после записи, подтверждение fsync неизвестно');
    });
  await expect(app.projects.archive(request)).rejects.toThrow();
  uncertain.mockRestore();
  await expect(app.projects.archive(request)).rejects.toMatchObject({
    code: 'STORAGE_UNAVAILABLE',
  });
});

it('нестабильная рабочая папка при завершении этапа не переводит исправное хранилище в read-only', async () => {
  const app = await projectHarness();
  const plan = stagePlan();
  plan.stages[0]!.verification = { kind: 'manual', instructions: 'Проверьте ответ' };
  const project = await draftProject(app, plan);
  const capture = app.coordinator.capture.bind(app.coordinator);
  let changing = false;
  const spy = vi.spyOn(app.coordinator, 'capture').mockImplementation((record) => {
    if (record.stages.implement?.status === 'manual') changing = true;
    if (changing)
      return Promise.reject(
        new ApplicationError('PROJECT_CHANGED', 'Редактор продолжает менять файл'),
      );
    return capture(record);
  });
  const running = await app.projects.acceptPlan({
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await app.runtime.wait(running.stages[0]!.runId!);
  await app.coordinator.serial.run(async () => undefined);
  spy.mockRestore();
  expect(app.projectStore.recoveryError).toBeUndefined();
  expect((await app.projectStore.get(project.projectId)).status).toBe('paused');
  expect(app.leases.busy()).toBe(false);
});
