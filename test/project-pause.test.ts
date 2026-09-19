import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, ScriptedProvider, output, call, eventually } from './helpers.js';
import { projectInput } from './project-runtime-helpers.js';

describe('Мягкая пауза дерева проекта', () => {
  it('дожидается начатой записи и оставляет следующую для resume без повторного эффекта', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index
          ? output('Готово')
          : output('', [call('first', 'test.write', {}), call('second', 'test.write', {})]),
      ),
    );
    app.registry.register({
      definition: {
        name: 'test.write',
        description: 'Управляемая запись',
        effect: 'write',
        schema: { type: 'object' },
      },
      async execute(_, context) {
        writes++;
        if (writes === 1) {
          await gate;
          expect(context.signal.aborted).toBe(false);
        }
        return { ok: true };
      },
    });
    const port = app.runtime.projectRuns();
    const { runId } = await port.start(projectInput(app));
    await eventually(() => writes === 1);
    let paused = false;
    const pause = port.pause(runId).then(() => {
      paused = true;
    });
    await eventually(() => !!app.sessions.get(runId).pauseRequested);
    expect(paused).toBe(false);
    release();
    await pause;
    expect(writes).toBe(1);
    expect((await port.inspect(runId)).status).toBe('paused');
    expect(
      Object.values((await port.inspect(runId)).invocations).map((item) => item.status),
    ).toEqual(['succeeded']);
    await port.resume(runId);
    await app.runtime.wait(runId);
    expect(writes).toBe(2);
    expect((await port.inspect(runId)).status).toBe('completed');
  });

  it('прерывает ожидание человека, сохраняя запрос и тот же вызов для продолжения', async () => {
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index
          ? output('Готово')
          : output('', [call('write', 'fs.write', { path: 'result', content: 'ok' })]),
      ),
      (config) => {
        config.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
      },
    );
    const port = app.runtime.projectRuns();
    const { runId } = await port.start(projectInput(app));
    await eventually(() => app.approvals.pending().length === 1);
    const approvalId = app.approvals.pending()[0]!.id;
    await port.pause(runId);
    const paused = await port.inspect(runId);
    expect(paused.status).toBe('paused');
    expect(Object.keys(paused.invocations)).toHaveLength(0);
    expect(paused.approvals[approvalId]!.status).toBe('pending');
    await port.resume(runId);
    await app.approvals.resolve(approvalId, true);
    await app.runtime.wait(runId);
    expect(await readFile(join(app.workspace, 'result'), 'utf8')).toBe('ok');
    expect(Object.keys((await port.inspect(runId)).approvals)).toEqual([approvalId]);
  });

  it('останавливает agents.await и дочерний ask без потери дочернего результата', async () => {
    const provider = new ScriptedProvider((request) => {
      const role = request.messages[0]!.content;
      const tools = request.messages.filter((item) => item.role === 'tool');
      if (role.includes('ACTIVE ROLE: worker'))
        return tools.length
          ? output('Рабочий закончил')
          : output('', [call('child-write', 'fs.write', { path: 'child', content: 'done' })]);
      if (!tools.length)
        return output('', [
          call('delegate', 'agents.delegate', { role: 'worker', task: 'Запиши файл' }),
        ]);
      const delegated = tools.find((item) => item.toolCallId === 'delegate');
      if (!tools.some((item) => item.toolCallId === 'await'))
        return output('', [
          call('await', 'agents.await', { agentId: JSON.parse(delegated!.content).agentId }),
        ]);
      expect(tools.find((item) => item.toolCallId === 'await')!.content).toContain(
        'Рабочий закончил',
      );
      return output('Всё готово');
    });
    const app = await harness(provider, (config) => {
      config.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
    });
    const port = app.runtime.projectRuns();
    const { runId } = await port.start({ ...projectInput(app), role: 'coordinator' });
    await eventually(
      () =>
        app.approvals.pending().length === 1 &&
        Object.values(app.sessions.get(runId).invocations).some(
          (item) => item.call.name === 'agents.await' && item.status === 'started',
        ),
    );
    const approvalId = app.approvals.pending()[0]!.id;
    await port.pause(runId);
    const paused = await port.inspect(runId);
    expect(paused.status).toBe('paused');
    expect(Object.values(paused.agents).some((agent) => agent.status === 'failed')).toBe(false);
    expect(Object.values(paused.invocations).some((item) => item.status === 'started')).toBe(false);
    await port.resume(runId);
    await app.approvals.resolve(approvalId, true);
    await app.runtime.wait(runId);
    expect((await port.inspect(runId)).result).toBe('Всё готово');
    expect(await readFile(join(app.workspace, 'child'), 'utf8')).toBe('done');
  });

  it('прерывает model request без потери завершённых обменов и уведомляет после settle', async () => {
    const provider = new ScriptedProvider(async (request, index) => {
      if (index) return output('Продолжено');
      await new Promise<void>((_, reject) =>
        request.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        }),
      );
      return output('Невозможно');
    });
    const app = await harness(provider);
    const port = app.runtime.projectRuns();
    let reservation = 0;
    app.runtime.setWorkspaceAccess({
      reserve() {
        reservation++;
        return () => {
          reservation--;
        };
      },
      assertWrite() {},
    });
    const events: string[] = [];
    port.subscribeSettled((event) => {
      expect(port.busy(event.runId)).toBe(false);
      expect(reservation).toBe(0);
      events.push(event.status);
    });
    const { runId } = await port.start(projectInput(app));
    await eventually(() => provider.requests.length === 1);
    await port.pause(runId);
    expect(events).toEqual(['paused']);
    await port.resume(runId);
    await app.runtime.wait(runId);
    expect(events).toEqual(['paused', 'completed']);
  });
});
