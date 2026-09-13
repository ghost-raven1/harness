import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from '../src/providers/errors.js';
import { call, cleanup, eventually, harness, output, ScriptedProvider } from './helpers.js';

it('возобновление соседней ветки после 429 не оживляет потомка уже ошибочной ветки', async () => {
  let limited = true;
  let grandchildStarted = false;
  let grandchildCalls = 0;
  let app!: Awaited<ReturnType<typeof harness>>;
  const source = new ScriptedProvider(async (request) => {
    const hasTask = (task: string) =>
      request.messages.some((item) => item.role === 'user' && item.content === task);
    if (hasTask('Потомок ошибочной ветки')) {
      grandchildStarted = true;
      grandchildCalls++;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('Потомок отменён вместе с ошибочной веткой');
    }
    if (hasTask('Ошибочная ветка')) {
      if (!request.messages.some((item) => item.role === 'tool'))
        return output('', [
          call('grandchild', 'agents.delegate', {
            role: 'reader',
            task: 'Потомок ошибочной ветки',
          }),
        ]);
      await eventually(() => grandchildStarted);
      throw new Error('Родитель потомка завершился ошибкой');
    }
    if (hasTask('Ветка с 429')) {
      if (!limited) return output('Вторая ветка продолжена');
      await eventually(() =>
        app.sessions
          .list()
          .some((run) =>
            Object.values(run.agents).some(
              (agent) => agent.task === 'Ошибочная ветка' && agent.status === 'failed',
            ),
          ),
      );
      throw new ProviderError('Временное ограничение', false, false, { kind: 'rate_limit' });
    }
    if (!request.messages.some((item) => item.role === 'tool'))
      return output('', [
        call('failed-branch', 'agents.delegate', { role: 'worker', task: 'Ошибочная ветка' }),
        call('limited-branch', 'agents.delegate', { role: 'worker', task: 'Ветка с 429' }),
      ]);
    return output('Ошибочная ветка учтена, вторая завершена');
  });
  app = await harness(source);
  const { runId } = await app.runtime.start({
    message: 'Две независимые ветки',
    workspace: app.workspace,
    requestKey: 'failed-descendant-resume',
  });
  await app.runtime.wait(runId);
  const paused = app.sessions.get(runId);
  expect(paused.status).toBe('paused');
  const grandchild = Object.values(paused.agents).find(
    (agent) => agent.task === 'Потомок ошибочной ветки',
  )!;
  expect(grandchild.status).toBe('cancelled');
  expect(paused.agents[grandchild.parentId!]!.status).toBe('failed');
  limited = false;
  await app.runtime.resume(runId);
  await app.runtime.wait(runId);
  const finished = app.sessions.get(runId);
  expect(finished.status).toBe('completed');
  expect(grandchildCalls).toBe(1);
  expect(finished.agents[grandchild.id]!.status).toBe('cancelled');
  expect(Object.values(finished.agents).some((agent) => agent.status === 'running')).toBe(false);
});

it('уточнение при agents.await ждёт границы шага корня и не меняет текущую задачу ребёнка', async () => {
  const clarification = 'Учитывай только итоговые значения, без промежуточных';
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let childCalls = 0;
  let childSignal: AbortSignal | undefined;
  const source = new ScriptedProvider(async (request) => {
    if (request.messages.some((item) => item.content === 'Независимая проверка файла')) {
      childCalls++;
      expect(JSON.stringify(request.messages)).not.toContain(clarification);
      if (request.messages.some((item) => item.role === 'tool')) return output('Файл проверен');
      childSignal = request.signal;
      await childGate;
      return output('', [call('read-child', 'fs.read', { path: 'sample.txt' })]);
    }
    const delegated = request.messages.find((item) => item.toolCallId === 'delegate');
    if (!delegated)
      return output('', [
        call('delegate', 'agents.delegate', { role: 'worker', task: 'Независимая проверка файла' }),
      ]);
    if (!request.messages.some((item) => item.toolCallId === 'await'))
      return output('', [
        call('await', 'agents.await', { agentId: JSON.parse(delegated.content).agentId }),
      ]);
    expect(request.messages).toContainEqual({ role: 'user', content: clarification });
    expect(JSON.stringify(request.messages)).toContain('Файл проверен');
    return output('Уточнение и результат ребёнка учтены');
  });
  const app = await harness(source);
  cleanup(async () => releaseChild());
  await writeFile(join(app.workspace, 'sample.txt'), 'Проверяемые данные');
  const { runId } = await app.runtime.start({
    message: 'Дождись проверки файла',
    workspace: app.workspace,
    requestKey: 'clarification-during-await',
  });
  await eventually(() =>
    Object.values(app.sessions.get(runId).invocations).some(
      (invocation) => invocation.call.id === 'await' && invocation.status === 'started',
    ),
  );
  const receipt = await app.runtime.sendMessage({
    runId,
    message: clarification,
    requestKey: 'clarification',
  });
  expect(receipt.status).toBe('queued');
  expect(app.sessions.get(runId).userMessages![0]!.deliveredAt).toBeUndefined();
  expect(childSignal?.aborted).toBe(false);
  releaseChild();
  await app.runtime.wait(runId);
  const finished = app.sessions.get(runId);
  expect(finished).toMatchObject({
    status: 'completed',
    result: 'Уточнение и результат ребёнка учтены',
  });
  expect(childCalls).toBe(2);
  expect(Object.values(finished.agents)).toHaveLength(2);
  expect(finished.userMessages![0]!.deliveredAt).toBeDefined();
  const messages = finished.agents[finished.rootAgentId]!.messages;
  const answer = messages.findIndex((item) => item.toolCallId === 'await');
  const human = messages.findIndex((item) => item.content === clarification);
  expect(human).toBeGreaterThan(answer);
  expect(messages.filter((item) => item.content === clarification)).toHaveLength(1);
});
