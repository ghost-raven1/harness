import { expect, it } from 'vitest';
import { eventually, harness, ScriptedProvider } from './helpers.js';

it('мгновенный отказ модели при abort не перезаписывает отмену ошибкой', async () => {
  const provider = new ScriptedProvider(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('CANCELLED')), {
          once: true,
        });
      }),
  );
  const app = await harness(provider);
  const { runId } = await app.runtime.start({
    message: 'Долгая задача',
    workspace: app.workspace,
    requestKey: 'cancel-race',
  });
  await eventually(() => provider.requests.length === 1);
  await app.runtime.cancel(runId);
  const run = app.sessions.get(runId);
  expect(run.status).toBe('cancelled');
  expect(run.error).toBeUndefined();
  expect((await app.sessions.history(runId, 0)).some((event) => event.type === 'run.failed')).toBe(
    false,
  );
  expect(Object.values(run.agents).every((agent) => agent.status === 'cancelled')).toBe(true);
});
