import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApplication } from '../src/interfaces/application.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  ScriptedProvider,
} from './helpers.js';

it.each([false, true])(
  'одобренный вызов не превращается в отказ после перезапуска перед tool.started, старый журнал: %s',
  async (legacy) => {
    const app = await harness(new ScriptedProvider(() => output('Готово')), (config) => {
      config.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
    });
    const { runId } = await app.runtime.start({
      message: 'Одна запись',
      workspace: app.workspace,
      requestKey: 'approval-boundary',
    });
    await app.runtime.wait(runId);
    const pending = call('approved', 'fs.write', {
      path: 'approved.txt',
      content: 'Разрешено человеком',
    });
    const agentId = app.sessions.get(runId).rootAgentId;
    await app.sessions.mutate(runId, 'test.pending', {}, (state) => {
      state.status = 'running';
      const agent = state.agents[agentId]!;
      agent.status = 'running';
      agent.messages.push({ role: 'assistant', content: '', toolCalls: [pending] });
      agent.pending = [pending];
    });
    const decision = app.approvals.request(runId, agentId, pending, new AbortController().signal);
    await eventually(() => app.approvals.pending().length === 1);
    await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
    expect(await decision).toBe(true);
    expect(Object.keys(app.sessions.get(runId).invocations)).toHaveLength(0);
    expect(Object.values(app.sessions.get(runId).approvals)[0]?.status).toBe('allowed');
    if (legacy)
      await app.sessions.mutate(runId, 'approval.consumed', {}, (run) => {
        Object.values(run.approvals)[0]!.status = 'consumed';
      });
    // Ни один исполнитель не запускался: восстанавливаем окно между разрешением и началом операции.
    const configFile = await configDirectory(app.directory, 'http://127.0.0.1:1/v1');
    const provider = new ScriptedProvider(() => output('Запись завершена'));
    const restored = await createApplication(configFile, app.sessions.directory, provider);
    cleanup(() => restored.close());
    await restored.runtime.resume(runId);
    await restored.runtime.wait(runId);
    const run = restored.sessions.get(runId);
    expect(run.invocations[agentId + ':approved']?.status).toBe('succeeded');
    expect(await readFile(join(app.workspace, 'approved.txt'), 'utf8')).toBe('Разрешено человеком');
    expect(Object.values(run.approvals).map((approval) => approval.status)).toEqual(['consumed']);
    const journal = (await readFile(join(app.sessions.directory, 'runs', runId + '.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const started = journal.find((event) => event.type === 'tool.started');
    expect(started.state.approvals[Object.keys(run.approvals)[0]!].status).toBe('consumed');
    expect(started.state.invocations[agentId + ':approved'].status).toBe('started');
    expect(
      await restored.approvals.request(runId, agentId, pending, new AbortController().signal),
    ).toBe(false);
  },
);
