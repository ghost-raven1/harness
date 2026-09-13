import { expect, it } from 'vitest';
import { toolSummary } from '../src/interfaces/tool-summary.js';
import { call, harness, output, ScriptedProvider } from './helpers.js';

it('обрезание stdout и stderr видно модели и CLI после упаковки большого результата в артефакт', async () => {
  const provider = new ScriptedProvider((_, index) =>
    index === 0
      ? output('', [
          call('large-output', 'process.exec', {
            command: process.execPath,
            args: [
              '-e',
              "process.stdout.write('x'.repeat(1048577)); process.stderr.write('y'.repeat(1048577));",
            ],
          }),
        ])
      : output('Проверка завершена'),
  );
  const app = await harness(provider, (config) => {
    config.policy.rules = [{ tool: '*', decision: 'allow', args: {} }];
    config.tools.timeoutMs = 10000;
  });
  const { runId } = await app.runtime.start({
    message: 'Проверить длинный вывод команды',
    workspace: app.workspace,
    requestKey: 'process-artifact',
  });
  await app.runtime.wait(runId);
  const run = app.sessions.get(runId);
  expect(run.status).toBe('completed');
  const invocation = run.invocations[run.rootAgentId + ':large-output']!;
  const envelope = JSON.parse(invocation.result!);
  expect(envelope).toMatchObject({
    truncated: true,
    stdoutTruncated: true,
    stderrTruncated: true,
    artifactId: expect.any(String),
  });
  const modelResult = provider.requests[1]!.messages.find(
    (message) => message.role === 'tool' && message.toolCallId === 'large-output',
  );
  expect(modelResult?.content).toBe(invocation.result);
  expect(toolSummary(invocation).detail).toContain('Вывод команды обрезан: конец не сохранён.');
  expect(toolSummary(invocation).detail).toContain('Вывод ошибок обрезан: конец не сохранён.');
});
