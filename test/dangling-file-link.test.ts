import { lstat, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { call, harness, output, ScriptedProvider } from './helpers.js';

it.each(['outside', 'denied'])(
  'запись через оборванную ссылку не обходит ограничение пути: %s',
  async (target) => {
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index
          ? output('Запись отклонена')
          : output('', [call('write', 'fs.write', { path: 'link.txt', content: 'Изменение' })]),
      ),
    );
    const destination =
      target === 'outside' ? join(app.directory, 'outside.txt') : join(app.workspace, '.env');
    const link = join(app.workspace, 'link.txt');
    await symlink(destination, link);
    const { runId } = await app.runtime.start({
      message: 'Запиши файл',
      workspace: app.workspace,
      requestKey: 'dangling-link',
    });
    await app.runtime.wait(runId);
    expect(Object.values(app.sessions.get(runId).invocations)[0]?.status).toBe('error');
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  },
);
