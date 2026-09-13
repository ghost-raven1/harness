import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import { cleanup, configDirectory, eventually, output, temporary } from './helpers.js';

it.each(['completed', 'failed'] as const)(
  'диагностика реального сервиса фиксирует %s и переживает перезапуск без утечки текста',
  async (status) => {
    const root = await temporary(),
      directory = join(root, 'state');
    const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
    const privateText = 'PRIVATE_TASK_AND_RESPONSE_fixture';
    const provider = {
      generate: async () => {
        if (status === 'failed') throw new Error(privateText);
        return output(privateText);
      },
    };
    let app = await createApplication(config, directory, provider);
    cleanup(() => app.close());
    await dispatch(app, 'diagnostics.configure', { enabled: true });
    const { runId } = (await dispatch(app, 'runtime.run', {
      message: privateText,
      workspace: join(root, 'workspace'),
      requestKey: privateText,
    })) as { runId: string };
    await eventually(() => !app.runtime.busy());
    expect(app.sessions.get(runId).status).toBe(status);
    await expect(dispatch(app, 'PRIVATE_METHOD_fixture', {})).rejects.toThrow();
    await app.close();
    app = await createApplication(config, directory, provider);
    expect(await dispatch(app, 'diagnostics.status', {})).toMatchObject({ enabled: true });
    const path = join(directory, 'logs', 'harness.jsonl');
    const content = await readFile(path, 'utf8');
    const events = content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'task.finished', runId, status }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'command.failed', method: 'unknown' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'service.stopped' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'service.started' }));
    expect(content).not.toMatch(/PRIVATE_TASK_AND_RESPONSE|PRIVATE_METHOD/);
    await dispatch(app, 'diagnostics.configure', { enabled: false });
    await dispatch(app, 'learning.pause', {});
    expect(await readFile(path, 'utf8')).toBe(content);
  },
);
