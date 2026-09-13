import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
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

it('при пределе 1 делает паузу перед следующим API, продолжает тот же журнал и не повторяет запись', async () => {
  const source = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [
          call('write-once', 'fs.write', { path: 'result.txt', content: 'Первая запись' }),
        ])
      : output('Готово'),
  );
  const app = await harness(source, (config) => {
    config.limits.turns = 1;
  });
  const { runId, sessionId } = await app.runtime.start({
    message: 'Запиши и проверь',
    workspace: app.workspace,
    requestKey: 'one-step',
  });
  await app.runtime.wait(runId);
  const before = app.sessions.get(runId);
  const history = app.sessions.history(runId, 0);
  expect(before.status).toBe('paused');
  expect(before.pauseReason).toBe('iterations');
  expect(before.turns).toBe(1);
  expect(before.fileChanges).toHaveLength(1);
  expect(source.requests).toHaveLength(1);
  expect((await app.runtime.iterationStatus(runId)).run).toEqual({
    limit: 1,
    used: 1,
    total: 1,
    remaining: 0,
    pausedByLimit: true,
    editable: true,
  });
  await writeFile(join(app.workspace, 'result.txt'), 'Изменено человеком');
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  const after = app.sessions.get(runId);
  expect(after).toMatchObject({
    id: runId,
    sessionId,
    status: 'completed',
    turns: 2,
    iterationStart: 1,
  });
  expect(after.pauseReason).toBeUndefined();
  expect(after.config).toEqual(before.config);
  expect(after.learningVersion).toBe(before.learningVersion);
  expect(after.fileChanges).toEqual(before.fileChanges);
  expect(after.invocations).toEqual(before.invocations);
  expect(app.sessions.history(runId, 0).slice(0, history.length)).toEqual(history);
  expect(await readFile(join(app.workspace, 'result.txt'), 'utf8')).toBe('Изменено человеком');
  expect(source.requests).toHaveLength(2);
  expect((await app.runtime.iterationStatus(runId)).run).toMatchObject({
    used: 1,
    total: 2,
    editable: false,
    pausedByLimit: false,
  });
});

it('делит предел между дочерними агентами и останавливает дерево на паузе при гонке запросов', async () => {
  let complete = false;
  const source = new ScriptedProvider((_, index) =>
    complete
      ? output('Ветка завершена')
      : index === 0
        ? output('', [
            call('left', 'agents.delegate', { role: 'worker', task: 'Левая ветка' }),
            call('right', 'agents.delegate', { role: 'worker', task: 'Правая ветка' }),
          ])
        : output('', [call('read-' + index, 'fs.read', { path: 'sample.txt' })]),
  );
  const app = await harness(source, (config) => {
    config.limits.turns = 2;
  });
  await writeFile(join(app.workspace, 'sample.txt'), 'Данные');
  const { runId } = await app.runtime.start({
    message: 'Две ветки',
    workspace: app.workspace,
    requestKey: 'shared-steps',
  });
  await app.runtime.wait(runId);
  const paused = app.sessions.get(runId);
  expect(paused.status).toBe('paused');
  expect(paused.pauseReason).toBe('iterations');
  expect(paused.turns).toBe(2);
  expect(Object.values(paused.agents)).toHaveLength(3);
  expect(Object.values(paused.agents).some((agent) => agent.status === 'failed')).toBe(false);
  expect(source.requests.length).toBeLessThanOrEqual(2);
  expect(app.runtime.busy()).toBe(false);
  await app.runtime.setIterationLimit(3, runId, 2);
  const before = app.sessions.get(runId);
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  const continued = app.sessions.get(runId);
  expect(continued.status).toBe('paused');
  expect(continued.pauseReason).toBe('iterations');
  expect(continued.turns).toBe(5);
  expect(continued.iterationStart).toBe(2);
  expect(continued.config).toEqual(before.config);
  expect(Object.values(continued.agents)).toHaveLength(3);
  complete = true;
  await app.runtime.setIterationLimit(8, runId, 3);
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  const finished = app.sessions.get(runId);
  expect(finished.status).toBe('completed');
  expect(Object.values(finished.agents)).toHaveLength(3);
  expect(Object.values(finished.agents).every((agent) => agent.status === 'completed')).toBe(true);
  expect(finished.agents[finished.rootAgentId]!.collectedChildren).toHaveLength(2);
  expect(
    finished.agents[finished.rootAgentId]!.messages.some(
      (message) =>
        message.content.includes('Ветка завершена') && message.content.includes('agentId'),
    ),
  ).toBe(true);
});

it('сохраняет default после перезапуска, меняет только новые задачи и проверяет устаревшее подтверждение', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const source = new ScriptedProvider((_, index) =>
    output('', [call('read-' + index, 'fs.list', { path: '.' })]),
  );
  const app = await createApplication(configFile, join(directory, 'state'), source);
  cleanup(() => app.close());
  const initial = await app.runtime.iterationStatus();
  await app.runtime.setIterationLimit(1, undefined, initial.defaultLimit);
  const { runId } = await app.runtime.start({
    message: 'Старый предел',
    workspace: join(directory, 'workspace'),
    requestKey: 'existing',
  });
  await app.runtime.wait(runId);
  const frozen = app.sessions.get(runId).config;
  const updates = await Promise.allSettled([
    app.runtime.setIterationLimit(3, undefined, 1),
    app.runtime.setIterationLimit(4, undefined, 1),
  ]);
  expect(updates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const winningLimit = updates[0]!.status === 'fulfilled' ? 3 : 4;
  const conflict = updates.find((result) => result.status === 'rejected');
  expect(conflict?.status === 'rejected' && conflict.reason.message).toContain('уже изменился');
  expect((await app.runtime.iterationStatus(runId)).run?.limit).toBe(1);
  await app.runtime.setIterationLimit(2, runId, 1);
  await expect(app.runtime.setIterationLimit(5, runId, 1)).rejects.toThrow('уже изменился');
  expect(app.sessions.get(runId).config).toEqual(frozen);
  await app.close();

  const restored = await createApplication(configFile, join(directory, 'state'), source);
  cleanup(() => restored.close());
  expect(await restored.runtime.iterationStatus()).toEqual({ defaultLimit: winningLimit });
  expect((await restored.runtime.iterationStatus(runId)).run).toMatchObject({ limit: 2, total: 1 });
  const next = await restored.runtime.start({
    message: 'Новый предел',
    workspace: join(directory, 'workspace'),
    requestKey: 'new',
  });
  await restored.runtime.wait(next.runId);
  expect(restored.sessions.get(next.runId).turns).toBe(winningLimit);
  expect(restored.sessions.get(next.runId).iterationLimit).toBe(winningLimit);
  const historyBefore = restored.sessions.history(runId, 0);
  await restored.runtime.resume(runId);
  await restored.runtime.wait(runId);
  expect(restored.sessions.get(runId)).toMatchObject({
    turns: 3,
    iterationStart: 1,
    iterationLimit: 2,
  });
  expect(restored.sessions.history(runId, 0).slice(0, historyBefore.length)).toEqual(historyBefore);
});

it('продолжает старую запись без новых полей с отдельной порцией и прежним пределом из снимка', async () => {
  const source = new ScriptedProvider((_, index) =>
    output('', [call('read-' + index, 'fs.list', { path: '.' })]),
  );
  const app = await harness(source, (config) => {
    config.limits.turns = 1;
  });
  const { runId } = await app.runtime.start({
    message: 'Старый формат',
    workspace: app.workspace,
    requestKey: 'legacy-steps',
  });
  await app.runtime.wait(runId);
  await app.sessions.mutate(runId, 'fixture.legacy_fields', {}, (run) => {
    delete run.iterationLimit;
    delete run.iterationStart;
    delete run.pauseReason;
    run.error = 'Достигнута квота этой задачи';
  });
  const before = app.sessions.get(runId);
  await app.runtime.setIterationLimit(100);
  expect((await app.runtime.iterationStatus(runId)).run).toMatchObject({
    limit: 1,
    used: 1,
    total: 1,
  });
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId)).toMatchObject({
    status: 'paused',
    turns: 2,
    iterationStart: 1,
    iterationLimit: 1,
    pauseReason: 'iterations',
  });
  expect(app.sessions.get(runId).config).toEqual(before.config);
  expect(app.sessions.get(runId).learningVersion).toEqual(before.learningVersion);
});

it('не меняет предел работающей задачи; default не влияет на неё, неизвестный исход не сбрасывает порцию', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = new ScriptedProvider(async () => {
    await gate;
    return output('Готово');
  });
  const app = await harness(source);
  const { runId } = await app.runtime.start({
    message: 'Работающий запуск',
    workspace: app.workspace,
    requestKey: 'running-steps',
  });
  try {
    await eventually(() => source.requests.length === 1);
    const before = app.sessions.get(runId);
    expect((await app.runtime.iterationStatus(runId)).run?.editable).toBe(false);
    await expect(app.runtime.setIterationLimit(1, runId)).rejects.toThrow('на паузе');
    await app.runtime.setIterationLimit(1);
    expect(app.sessions.get(runId)).toEqual(before);
  } finally {
    release();
    await app.runtime.wait(runId);
  }
  await app.sessions.mutate(runId, 'fixture.unknown', {}, (run) => {
    run.status = 'paused';
    run.invocations.unknown = {
      id: 'unknown',
      agentId: run.rootAgentId,
      call: call('unknown', 'fs.write', {}),
      effect: 'write',
      status: 'unknown',
      startedAt: new Date().toISOString(),
    };
  });
  const before = app.sessions.get(runId);
  await expect(app.runtime.resume(runId)).rejects.toThrow('Resolve unknown');
  expect(app.sessions.get(runId)).toEqual(before);
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    await expect(app.runtime.setIterationLimit(limit)).rejects.toThrow('целым');
});

it('учитывает изменение предела в конфиге без перезапуска одинаково для статуса, подтверждения и новых задач', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const manifest = JSON.parse(await readFile(configFile, 'utf8'));
  manifest.limits = { ...manifest.limits, turns: 2 };
  await writeFile(configFile, JSON.stringify(manifest));
  const source = new ScriptedProvider((_, index) =>
    output('', [call('read-' + index, 'fs.list', { path: '.' })]),
  );
  const app = await createApplication(configFile, join(directory, 'state'), source);
  cleanup(() => app.close());
  expect(await app.runtime.iterationStatus()).toEqual({ defaultLimit: 2 });
  manifest.limits.turns = 3;
  await writeFile(configFile, JSON.stringify(manifest));
  expect(await app.runtime.iterationStatus()).toEqual({ defaultLimit: 3 });
  await expect(app.runtime.setIterationLimit(5, undefined, 2)).rejects.toThrow('уже изменился');
  const { runId } = await app.runtime.start({
    message: 'Актуальный конфиг',
    workspace: join(directory, 'workspace'),
    requestKey: 'fresh-config',
  });
  await app.runtime.wait(runId);
  const before = app.sessions.get(runId);
  expect(before).toMatchObject({ status: 'paused', iterationLimit: 3, turns: 3 });
  await app.runtime.setIterationLimit(5, undefined, 3);
  manifest.limits.turns = 7;
  await writeFile(configFile, JSON.stringify(manifest));
  expect(await app.runtime.iterationStatus()).toEqual({ defaultLimit: 5 });
  const next = await app.runtime.start({
    message: 'Настройка интерфейса важнее значения конфигурации',
    workspace: join(directory, 'workspace'),
    requestKey: 'explicit-default',
  });
  await app.runtime.wait(next.runId);
  expect(app.sessions.get(next.runId).iterationLimit).toBe(5);
  expect(app.sessions.get(next.runId).turns).toBe(5);
  expect(app.sessions.get(runId)).toEqual(before);
});

it('не меняет предел скрытой задачи на паузе, даже с прежним подтверждением', async () => {
  const app = await harness(new ScriptedProvider(() => output('Готово')));
  const { runId } = await app.runtime.start({
    message: 'Скрытая задача',
    workspace: app.workspace,
    requestKey: 'hidden-steps',
  });
  await app.runtime.wait(runId);
  const initial = await app.runtime.iterationStatus(runId);
  await app.sessions.delete(runId);
  // В старых данных могла сохраниться пауза уже скрытой задачи.
  await app.sessions.mutate(runId, 'fixture.hidden_pause', {}, (run) => {
    run.status = 'paused';
  });
  const before = app.sessions.get(runId);
  expect((await app.runtime.iterationStatus(runId)).run?.editable).toBe(false);
  await expect(app.runtime.setIterationLimit(1, runId, initial.run!.limit)).rejects.toThrow(
    'только для просмотра',
  );
  expect(app.sessions.get(runId)).toEqual(before);
  expect((await app.runtime.iterationStatus()).defaultLimit).toBe(initial.defaultLimit);
});
