import { it, expect, vi } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { ProviderError } from '../src/providers/errors.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  ScriptedProvider,
} from './helpers.js';

it('отказ JSON-снимка не отменяет создание и завершение уже сохранённой в журнале задачи', async () => {
  const provider = new ScriptedProvider(() => output('Сохранённый ответ'));
  const app = await harness(provider);
  const create = app.sessions.create.bind(app.sessions);
  vi.spyOn(app.sessions, 'create').mockImplementation(async (run) => {
    // Каталог на месте зеркала вызывает настоящий отказ rename, оставляя журнал доступным.
    await mkdir(join(app.sessions.directory, 'runs', run.id + '.json'));
    return create(run);
  });
  const request = {
    message: 'Проверь журнал',
    workspace: app.workspace,
    requestKey: 'mirror-fault',
  };
  const { runId } = await app.runtime.start(request);
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('completed');
  expect(app.sessions.get(runId).result).toBe('Сохранённый ответ');
  expect(await app.runtime.start(request)).toEqual({
    runId,
    sessionId: app.sessions.get(runId).sessionId,
  });
  expect(provider.requests).toHaveLength(1);
  expect(
    (await readdir(join(app.sessions.directory, 'runs'))).filter((name) => name.endsWith('.tmp')),
  ).toEqual([]);
  const restored = new FileSessionStore(app.sessions.directory);
  await restored.initialize();
  expect(restored.get(runId)).toEqual(app.sessions.get(runId));
});

it.each(['paused', 'cancelled', 'hidden'] as const)(
  'восстановление %s сохраняет неизвестный исход начатой записи и не меняет завершённые операции',
  async (status) => {
    const app = await harness(new ScriptedProvider(() => output('Готово')));
    const { runId } = await app.runtime.start({
      message: 'Проверка',
      workspace: app.workspace,
      requestKey: status,
    });
    await app.runtime.wait(runId);
    await app.sessions.mutate(runId, 'test.interrupted', {}, (run) => {
      run.status = status === 'paused' ? 'paused' : 'cancelled';
      if (status === 'hidden') run.deletedAt = new Date().toISOString();
      for (const effect of ['write', 'read', 'control'] as const) {
        run.invocations[effect] = {
          id: effect,
          agentId: run.rootAgentId,
          effect,
          status: 'started',
          call: call(effect, effect === 'control' ? 'agents.await' : 'fs.' + effect, {}),
          startedAt: new Date().toISOString(),
        };
      }
      run.invocations.done = {
        ...run.invocations.write!,
        id: 'done',
        status: 'succeeded',
        result: 'Проверенный результат',
      };
    });
    const before = app.sessions.get(runId);
    const restored = new FileSessionStore(app.sessions.directory);
    await restored.initialize();
    const after = restored.get(runId);
    expect(after.status).toBe(before.status);
    expect(after.deletedAt).toBe(before.deletedAt);
    expect(after.invocations.write?.status).toBe('unknown');
    expect(after.invocations.read?.status).toBe('error');
    expect(after.invocations.control?.status).toBe('error');
    expect(after.invocations.done).toEqual(before.invocations.done);
    expect(after.config).toEqual(before.config);
    expect(after.learningVersion).toBe(before.learningVersion);
  },
);

it('авария после паузы дерева до остановки записи ребёнка не разрешает повторный эффект', async () => {
  let allowFinish!: () => void;
  const gate = new Promise<void>((resolve) => {
    allowFinish = resolve;
  });
  let writes = 0;
  const source = new ScriptedProvider(async (request) => {
    if (request.messages.some((message) => message.content === 'Дочерняя запись'))
      return output('', [call('child-write', 'test.write', {})]);
    if (!request.messages.some((message) => message.toolCallId === 'delegate'))
      return output('', [
        call('delegate', 'agents.delegate', { role: 'worker', task: 'Дочерняя запись' }),
      ]);
    await eventually(() => writes === 1);
    throw new ProviderError('Провайдер временно ограничил запросы', false, false, {
      kind: 'rate_limit',
    });
  });
  const app = await harness(source);
  app.registry.register({
    definition: {
      name: 'test.write',
      description: 'Проверочная запись',
      effect: 'write',
      schema: { type: 'object' },
    },
    async execute() {
      writes++;
      await writeFile(join(app.workspace, 'effect.txt'), 'Записано один раз');
      await gate;
      return { ok: true };
    },
  });
  const { runId } = await app.runtime.start({
    message: 'Делегируй запись',
    workspace: app.workspace,
    requestKey: 'paused-tree-crash',
  });
  await eventually(() => app.sessions.get(runId).status === 'paused');
  const events = app.sessions.history(runId, 0);
  const last = events.at(-1)!;
  expect(last.type).toBe('run.paused');
  expect(
    Object.values(last.state.invocations).find((invocation) => invocation.effect === 'write')
      ?.status,
  ).toBe('started');
  allowFinish();
  await app.runtime.wait(runId);
  // Восстанавливаем точную границу аварии из настоящего журнала, сохраняя более поздний снимок.
  await writeFile(
    join(app.sessions.directory, 'runs', runId + '.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const configFile = await configDirectory(app.directory, 'http://127.0.0.1:1/v1');
  const resumed = new ScriptedProvider(() => output('Продолжение'));
  const restored = await createApplication(configFile, app.sessions.directory, resumed);
  cleanup(() => restored.close());
  expect(restored.sessions.get(runId).status).toBe('paused');
  expect(
    Object.values(restored.sessions.get(runId).invocations).find(
      (invocation) => invocation.effect === 'write',
    )?.status,
  ).toBe('unknown');
  await expect(restored.runtime.resume(runId)).rejects.toThrow('Resolve unknown');
  expect(resumed.requests).toHaveLength(0);
  expect(writes).toBe(1);
  expect(await readFile(join(app.workspace, 'effect.txt'), 'utf8')).toBe('Записано один раз');
});

it.each(['wait', 'poll'] as const)(
  'отказ записи восстановления не ломает %s и запрещает resume начатой мутации до проверки исхода',
  async (mode) => {
    const provider = new ScriptedProvider((_, index) =>
      index === 0 ? output('', [call('write', 'test.write', {})]) : output('Результат проверен'),
    );
    const app = await harness(provider);
    let writes = 0;
    app.registry.register({
      definition: {
        name: 'test.write',
        description: 'Проверочная запись',
        effect: 'write',
        schema: { type: 'object' },
      },
      async execute() {
        writes++;
        await writeFile(join(app.workspace, 'effect.txt'), 'Выполнено');
        return { result: BigInt(1) };
      },
    });
    const mutate = app.sessions.mutate.bind(app.sessions);
    const unavailable = vi
      .spyOn(app.sessions, 'mutate')
      .mockImplementation((id, type, payload, update) => {
        if (['tool.unknown', 'run.recovered'].includes(type))
          return Promise.reject(new Error('Журнал временно недоступен'));
        return mutate(id, type, payload, update);
      });
    const { runId } = await app.runtime.start({
      message: 'Запиши результат',
      workspace: app.workspace,
      requestKey: 'recovery-write-fault',
    });
    if (mode === 'wait')
      await expect(app.runtime.wait(runId)).rejects.toThrow('Журнал временно недоступен');
    else await eventually(() => !app.runtime.busy());
    const stopped = app.sessions.get(runId);
    expect(stopped.status).toBe('paused');
    expect(app.runtime.runIterationStatus(runId).editable).toBe(true);
    const invocation = Object.values(stopped.invocations)[0]!;
    expect(invocation.status).toBe('started');
    await expect(app.runtime.resume(runId)).rejects.toThrow('Resolve unknown');
    expect(provider.requests).toHaveLength(1);
    expect(writes).toBe(1);
    unavailable.mockRestore();
    if (mode === 'wait') await app.sessions.recoverInterrupted(runId);
    else {
      const { runStatus } = await import('../src/interfaces/routes.js');
      const status = await runStatus(
        app as unknown as import('../src/interfaces/application.js').Application,
        runId,
      );
      expect(status.unknownInvocations).toMatchObject([{ id: invocation.id, tool: 'test.write' }]);
    }
    await app.runtime.resolveInvocation(runId, invocation.id, 'Файл проверен человеком', true);
    await app.runtime.resume(runId);
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).status).toBe('completed');
    expect(writes).toBe(1);
  },
);

it('новый вопрос в отменённой беседе не обходит проверку начатой записи после отказа восстановления', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index === 0 ? output('', [call('write', 'test.write', {})]) : output('Новый ответ'),
  );
  const app = await harness(provider);
  let writes = 0;
  app.registry.register({
    definition: {
      name: 'test.write',
      description: 'Проверочная запись',
      effect: 'write',
      schema: { type: 'object' },
    },
    async execute() {
      writes++;
      await writeFile(join(app.workspace, 'effect.txt'), 'Выполнено');
      return { result: BigInt(1) };
    },
  });
  const mutate = app.sessions.mutate.bind(app.sessions);
  const unavailable = vi
    .spyOn(app.sessions, 'mutate')
    .mockImplementation((id, type, payload, update) => {
      if (['tool.unknown', 'run.recovered'].includes(type))
        return Promise.reject(new Error('Журнал временно недоступен'));
      return mutate(id, type, payload, update);
    });
  const { runId, sessionId } = await app.runtime.start({
    message: 'Запиши результат',
    workspace: app.workspace,
    requestKey: 'cancelled-write-fault',
  });
  await expect(app.runtime.wait(runId)).rejects.toThrow('Журнал временно недоступен');
  await app.runtime.cancel(runId);
  expect(app.sessions.get(runId).status).toBe('cancelled');
  expect(Object.values(app.sessions.get(runId).invocations)[0]?.status).toBe('started');
  const before = app.sessions.list(true);
  await expect(
    app.runtime.start({
      message: 'Продолжи беседу',
      workspace: app.workspace,
      sessionId,
      requestKey: 'cancelled-followup',
    }),
  ).rejects.toThrow('операция с неизвестным результатом');
  expect(app.sessions.list(true)).toEqual(before);
  expect(provider.requests).toHaveLength(1);
  expect(writes).toBe(1);
  unavailable.mockRestore();
});
