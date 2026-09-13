import { expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { registerMaintenanceCommands } from '../src/interfaces/commands/maintenance.js';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { call, cleanup, configDirectory, output, ScriptedProvider, temporary } from './helpers.js';

it('команда меняет предел новых задач и отдельной паузы через тот же API, что использует CLI', async () => {
  const root = await temporary();
  const provider = new ScriptedProvider((_, index) =>
    index === 0 ? output('', [call('list-once', 'fs.list', { path: '.' })]) : output('Готово'),
  );
  const app = await createApplication(
    await configDirectory(root, 'http://127.0.0.1:1/v1'),
    join(root, 'state'),
    provider,
  );
  cleanup(() => app.close());
  const printed = vi.fn();
  const context: CliContext = {
    directory: () => app.directory,
    interactive: () => false,
    json: () => true,
    output: printed,
    request: ((method, params) => dispatch(app, method, params)) as CliContext['request'],
  };
  const command = async (...args: string[]) => {
    const program = new Command();
    registerMaintenanceCommands(program, context);
    await program.parseAsync(['node', 'harness', 'iterations', ...args]);
  };
  await command('--limit', '1');
  expect(printed).toHaveBeenLastCalledWith({ defaultLimit: 1 });
  const { runId } = await app.runtime.start({
    message: 'Прочитай папку и ответь',
    workspace: join(root, 'workspace'),
    requestKey: 'iteration-command',
  });
  await app.runtime.wait(runId);
  const paused = (await dispatch(app, 'runtime.status', { runId })) as StatusView;
  expect(paused.status).toBe('paused');
  expect(paused.iterations).toMatchObject({ limit: 1, used: 1, pausedByLimit: true });
  const frozenConfig = app.sessions.get(runId).config;
  await command('--run', runId, '--limit', '3');
  expect(printed).toHaveBeenLastCalledWith(
    expect.objectContaining({ defaultLimit: 1, run: expect.objectContaining({ limit: 3 }) }),
  );
  await expect(
    dispatch(app, 'iterations.configure', { runId, limit: 4, expectedLimit: 1 }),
  ).rejects.toThrow('изменился');
  expect(app.sessions.get(runId).config).toEqual(frozenConfig);
  await dispatch(app, 'runtime.resume', { runId });
  await app.runtime.wait(runId);
  await command('--run', runId);
  expect(printed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      defaultLimit: 1,
      run: expect.objectContaining({ limit: 3, used: 1, total: 2, remaining: 2, editable: false }),
    }),
  );
  expect(app.sessions.get(runId).status).toBe('completed');
  expect(provider.requests).toHaveLength(2);
  await writeFile(app.configFile, '{');
  await expect(dispatch(app, 'runtime.status', { runId })).resolves.toMatchObject({
    status: 'completed',
    result: 'Готово',
    iterations: { limit: 3, total: 2 },
  });
});
