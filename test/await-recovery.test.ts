import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { call, cleanup, configDirectory, harness, output, ScriptedProvider } from './helpers.js';

it('восстанавливает успешный agents.await между записью результата и добавлением сообщения родителю', async () => {
  let childCalls = 0;
  const source = new ScriptedProvider((request) => {
    if (request.messages.some((message) => message.content === 'Результат для await')) {
      childCalls++;
      return output('ПРОВЕРЕННЫЙ_РЕЗУЛЬТАТ_РЕБЁНКА');
    }
    const delegated = request.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'delegate',
    );
    if (!delegated)
      return output('', [
        call('delegate', 'agents.delegate', { role: 'worker', task: 'Результат для await' }),
      ]);
    if (
      !request.messages.some((message) => message.role === 'tool' && message.toolCallId === 'await')
    )
      return output('', [
        call('await', 'agents.await', { agentId: JSON.parse(delegated.content).agentId }),
      ]);
    return output('Родитель получил результат');
  });
  const app = await harness(source);
  const { runId } = await app.runtime.start({
    message: 'Дождись подзадачи',
    workspace: app.workspace,
    requestKey: 'await-recovery',
  });
  await app.runtime.wait(runId);
  const history = app.sessions.history(runId, 0);
  const boundary = history.findIndex(
    (event) =>
      event.type === 'tool.succeeded' &&
      Object.values(event.state.invocations).some(
        (invocation) => invocation.call.id === 'await' && invocation.status === 'succeeded',
      ),
  );
  expect(boundary).toBeGreaterThan(0);
  const atCrash = history[boundary]!.state;
  const root = atCrash.agents[atCrash.rootAgentId]!;
  expect(root.pending?.[0]?.id).toBe('await');
  expect(root.messages.some((message) => message.toolCallId === 'await')).toBe(false);
  expect(root.collectedChildren).toEqual([]);
  await app.runtime.close();
  // Оставляем только синхронизированный журнал до аварии; поздний снимок не должен воскресить будущее.
  await writeFile(
    join(app.sessions.directory, 'runs', runId + '.jsonl'),
    history
      .slice(0, boundary + 1)
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  const configFile = await configDirectory(app.directory, 'http://127.0.0.1:1/v1');
  const restored = await createApplication(configFile, app.sessions.directory, source);
  cleanup(() => restored.close());
  expect(restored.sessions.get(runId).status).toBe('paused');
  const requestsBefore = source.requests.length;
  await restored.runtime.resume(runId);
  await restored.runtime.wait(runId);
  const finished = restored.sessions.get(runId);
  const parent = finished.agents[finished.rootAgentId]!;
  expect(finished.status).toBe('completed');
  expect(parent.collectedChildren).toEqual(parent.children);
  expect(source.requests.length).toBe(requestsBefore + 1);
  expect(childCalls).toBe(1);
  expect(
    parent.messages.filter((message) => message.role === 'tool' && message.toolCallId === 'await'),
  ).toEqual([
    expect.objectContaining({ content: expect.stringContaining('ПРОВЕРЕННЫЙ_РЕЗУЛЬТАТ_РЕБЁНКА') }),
  ]);
  expect(finished.invocations).toEqual(atCrash.invocations);
});
