import { expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, ScriptedProvider, output, call, cleanup } from './helpers.js';
import { projectInput } from './project-runtime-helpers.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { FileLearningStore } from '../src/learning/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { registerLocalTools } from '../src/tools/local.js';
import { FileApprovalService, PolicyService } from '../src/policy/service.js';
import { InvocationExecutor } from '../src/runtime/executor.js';
import { ContextService } from '../src/context/service.js';
import { HarnessRuntime } from '../src/runtime/engine.js';

it('после аварии checks восстанавливает project link и не повторяет подтверждённую команду', async () => {
  const provider = new ScriptedProvider(() => {
    throw new Error('Проверки не используют модель');
  });
  const app = await harness(provider, (config) => {
    config.policy.rules = [{ tool: '*', decision: 'allow', args: {} }];
  });
  const input = projectInput(app, 'checks');
  input.calls = [
    call('check-once', 'process.exec', {
      command: process.execPath,
      args: ['-e', 'require("fs").appendFileSync("effects", "x")'],
    }),
  ];
  const { runId } = await app.runtime.projectRuns().start(input);
  await app.runtime.wait(runId);
  const history = await app.sessions.history(runId, 0);
  const boundary = history.findIndex((event) => event.type === 'tool.succeeded');
  expect(boundary).toBeGreaterThan(0);
  await app.runtime.close();
  await writeFile(
    join(app.sessions.directory, 'runs', runId + '.jsonl'),
    history
      .slice(0, boundary + 1)
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const store = new FileSessionStore(app.sessions.directory);
  await store.initialize();
  const learning = new FileLearningStore(app.sessions.directory);
  await learning.initialize();
  const registry = new ToolRegistry();
  registerLocalTools(registry, store);
  const policy = new PolicyService();
  const approvals = new FileApprovalService(store, policy);
  const executor = new InvocationExecutor(store, registry, new ToolScheduler(4), policy, approvals);
  const runtime = new HarnessRuntime({
    configFile: '',
    initialConfig: app.snapshot,
    store,
    learning,
    provider,
    registry,
    policy,
    executor,
    context: new ContextService(learning),
  });
  cleanup(() => runtime.close());
  const port = runtime.projectRuns();
  expect(port.find(input.requestKey)?.project).toEqual(input.link);
  expect((await port.inspect(runId)).status).toBe('paused');
  expect(provider.requests).toHaveLength(0);
  await port.resume(runId);
  await runtime.wait(runId);
  expect((await port.inspect(runId)).status).toBe('completed');
  expect((await port.inspect(runId)).config).toEqual(input.config);
  expect(await readFile(join(app.workspace, 'effects'), 'utf8')).toBe('x');
  expect(provider.requests).toHaveLength(0);
});

it('отказ подготовки зависимостей сохраняет runId и возобновляется без потери контекста', async () => {
  const provider = new ScriptedProvider(() => output('Подтверждённый полный ответ'));
  const app = await harness(provider);
  const port = app.runtime.projectRuns();
  const source = await port.start(projectInput(app));
  await app.runtime.wait(source.runId);
  const input = {
    ...projectInput(app),
    requestKey: 'with-context',
    dependencies: [{ runId: source.runId, title: 'Источник' }],
  };
  const artifact = vi
    .spyOn(app.sessions, 'artifact')
    .mockRejectedValueOnce(new Error('ENOSPC fixture'));
  await expect(port.start(input)).rejects.toThrow('ENOSPC');
  const runId = port.find(input.requestKey)!.id;
  expect((await port.inspect(runId)).status).toBe('paused');
  expect(provider.requests).toHaveLength(1);
  expect(await port.start(input)).toEqual({
    runId,
    sessionId: port.find(input.requestKey)!.sessionId,
  });
  expect(provider.requests).toHaveLength(1);
  artifact.mockRestore();
  await port.resume(runId);
  await app.runtime.wait(runId);
  const run = await port.inspect(runId);
  expect(run.status).toBe('completed');
  expect(run.artifacts).toHaveLength(1);
  expect(run.projectContextReady).toBe(true);
  expect(
    provider.requests
      .at(-1)!
      .messages.some((message) => message.content.includes(run.artifacts[0]!.id)),
  ).toBe(true);
});
