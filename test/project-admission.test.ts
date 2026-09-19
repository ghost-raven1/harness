import { describe, expect, it, vi } from 'vitest';
import { harness, ScriptedProvider, output, call, eventually } from './helpers.js';
import { projectInput } from './project-runtime-helpers.js';
import { ApplicationError } from '../src/shared/application-error.js';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';

describe('Допуск и управление проектным запуском', () => {
  it('резервирует папку до создания журнала и освобождает отказавший допуск', async () => {
    const app = await harness(new ScriptedProvider(() => output('Готово')));
    let reservations = 0;
    app.runtime.setWorkspaceAccess({
      reserve() {
        reservations++;
        return () => {
          reservations--;
        };
      },
      assertWrite() {},
    });
    const create = app.sessions.create.bind(app.sessions);
    vi.spyOn(app.sessions, 'create').mockImplementation(async (...args) => {
      expect(reservations).toBe(1);
      return create(...args);
    });
    const { runId } = await app.runtime.start({
      message: 'Обычная задача',
      workspace: app.workspace,
      requestKey: 'normal',
    });
    await app.runtime.wait(runId);
    expect(reservations).toBe(0);
    await expect(
      app.runtime
        .projectRuns()
        .start({ ...projectInput(app), dependencies: [{ runId, title: 'Чужая задача' }] }),
    ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    expect(reservations).toBe(0);
  });

  it('повторяет guard после разрешения; устаревший lease не допускает эффект', async () => {
    let allowed = true,
      writes = 0;
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index ? output('Проверено') : output('', [call('w', 'test.write', {})]),
      ),
      (config) => {
        config.policy.rules.push({ tool: 'test.write', decision: 'ask', args: {} });
      },
    );
    app.runtime.setWorkspaceAccess({
      reserve: () => () => undefined,
      assertWrite() {
        if (!allowed) throw new ApplicationError('PROJECT_CONFLICT', 'Lease lost');
      },
    });
    app.registry.register({
      definition: {
        name: 'test.write',
        effect: 'write',
        description: '',
        schema: { type: 'object' },
      },
      async execute() {
        writes++;
        return {};
      },
    });
    const { runId } = await app.runtime.projectRuns().start(projectInput(app));
    await eventually(() => app.approvals.pending().length === 1);
    allowed = false;
    await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
    await app.runtime.wait(runId);
    expect(writes).toBe(0);
    expect(Object.values((await app.sessions.load(runId)).invocations)[0]!.status).toBe('error');
    const events = await app.sessions.history(runId, 0);
    expect(events.some((event) => event.type === 'tool.started')).toBe(false);
  });

  it('обычные команды не управляют проектом, а внутреннее разрешение unknown позволяет продолжить без повтора', async () => {
    let writes = 0;
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index ? output('Восстановлено') : output('', [call('unknown', 'test.write', {})]),
      ),
    );
    app.registry.register({
      definition: {
        name: 'test.write',
        effect: 'write',
        description: '',
        schema: { type: 'object' },
      },
      async execute() {
        writes++;
        throw new ToolOutcomeUnknownError('Ответ потерян');
      },
    });
    const port = app.runtime.projectRuns();
    const input = projectInput(app);
    const ref = await port.start(input);
    await app.runtime.wait(ref.runId);
    const run = await port.inspect(ref.runId);
    const invocationId = Object.keys(run.invocations)[0]!;
    expect(run.status).toBe('paused');
    for (const operation of [
      () => app.runtime.cancel(run.id),
      () => app.runtime.resume(run.id),
      () => app.runtime.sendMessage({ runId: run.id, message: 'Обход', requestKey: 'msg' }),
      () => app.runtime.setIterationLimit(100, run.id),
      () => app.runtime.resolveInvocation(run.id, invocationId, 'ok', true),
      () =>
        app.runtime.start({
          message: 'Обход',
          workspace: app.workspace,
          requestKey: 'same-session',
          sessionId: run.sessionId,
        }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'PROJECT_MANAGED' });
    await expect(port.resume(run.id)).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME' });
    await port.resolve({ runId: run.id, invocationId, result: '{"ok":true}', succeeded: true });
    await port.resume(run.id);
    await app.runtime.wait(run.id);
    expect((await port.inspect(run.id)).result).toBe('Восстановлено');
    expect(writes).toBe(1);
    expect(port.find(input.requestKey)?.project).toEqual(input.link);
  });
});
