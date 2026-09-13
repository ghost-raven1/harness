import { expect, it } from 'vitest';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

it('не начинает следующую запись после неизвестного исхода предыдущей', async () => {
  const app = await harness(
    new ScriptedProvider(() =>
      output('', [call('first', 'test.write', {}), call('second', 'test.write', {})]),
    ),
  );
  let effects = 0;
  app.registry.register({
    definition: {
      name: 'test.write',
      effect: 'write',
      description: 'Запись с потерянным результатом',
      schema: { type: 'object' },
    },
    async execute() {
      effects++;
      throw new ToolOutcomeUnknownError('Ответ потерян после записи');
    },
  });
  const { runId } = await app.runtime.start({
    message: 'Две последовательные записи',
    workspace: app.workspace,
    requestKey: 'unknown-first-write',
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('paused');
  expect(effects).toBe(1);
});
