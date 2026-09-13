import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import type { ModelProvider } from '../src/providers/types.js';
import { temporary, configDirectory, cleanup, ScriptedProvider, output } from './helpers.js';

export async function inputApplication(
  provider: ModelProvider = new ScriptedProvider(() => output('Ответ')),
) {
  const directory = await temporary();
  const app = await createApplication(
    await configDirectory(directory, 'http://127.0.0.1:1/v1'),
    join(directory, 'state'),
    provider,
  );
  cleanup(() => app.close());
  return Object.assign(app, { workspace: join(directory, 'workspace') });
}
