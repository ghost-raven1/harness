import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../src/interfaces/application.js';
import { ToolOutcomeUnknownError } from '../src/tools/errors.js';
import { hash } from '../src/shared/primitives.js';
import {
  call,
  cleanup,
  configDirectory,
  eventually,
  harness,
  output,
  ScriptedProvider,
  temporary,
} from './helpers.js';

it.each(['paused', 'running'] as const)(
  'продолжает сохранённый запуск %s после перезапуска без прежних квот и повторной записи',
  async (savedStatus) => {
    const directory = await temporary();
    const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
    const stateDirectory = join(directory, 'state');
    const source = new ScriptedProvider((_, index) => {
      if (index === 0)
        return output('', [
          call('write-once', 'fs.write', { path: 'result.txt', content: 'Готово' }),
        ]);
      throw new Error('Имитируем остановку прежней версии перед следующим запросом');
    });
    const original = await createApplication(configFile, stateDirectory, source);
    cleanup(() => original.close());
    const { runId } = await original.runtime.start({
      message: 'Создай файл и проверь результат',
      workspace: join(directory, 'workspace'),
      requestKey: 'legacy-quota',
    });
    await original.runtime.wait(runId);
    expect(original.sessions.get(runId).fileChanges).toHaveLength(1);
    await original.sessions.mutate(runId, 'fixture.legacy_state', {}, (run) => {
      run.status = savedStatus;
      run.agents[run.rootAgentId]!.status = 'running';
      run.error = 'Достигнута квота этой задачи. Она сохранена на паузе.';
      run.config.value.limits.runTokens = 1;
      run.config.value.limits.dailyTokens = 1;
      run.config.value.learning.dailyTokens = 1;
      run.config.hash = hash(run.config.value);
    });
    const before = original.sessions.get(runId);
    const historyBefore = await original.sessions.history(runId, 0);
    const usageBefore = await original.runtime.usage.status(runId);
    await original.close();
    await writeFile(join(directory, 'workspace/result.txt'), 'Правка человека после остановки');
    const continued = new ScriptedProvider(() => output('Продолжено'));
    const recovered = await createApplication(configFile, stateDirectory, continued);
    cleanup(() => recovered.close());
    expect(recovered.sessions.get(runId).status).toBe('paused');
    expect(recovered.sessions.get(runId).error).toContain('Достигнута квота');
    expect(await recovered.runtime.usage.status(runId)).toEqual(usageBefore);
    expect(continued.requests).toHaveLength(0);
    await recovered.runtime.resume(runId);
    await recovered.runtime.wait(runId);
    const after = recovered.sessions.get(runId);
    expect(after.status).toBe('completed');
    expect(after.id).toBe(runId);
    expect(after.sessionId).toBe(before.sessionId);
    expect((await recovered.sessions.history(runId, 0)).slice(0, historyBefore.length)).toEqual(
      historyBefore,
    );
    expect(after.error).toBeUndefined();
    expect(after.turns).toBe(before.turns + 1);
    expect(after.config).toEqual(before.config);
    expect(after.learningVersion).toBe(before.learningVersion);
    expect(after.invocations).toEqual(before.invocations);
    expect(after.fileChanges).toEqual(before.fileChanges);
    expect(continued.requests).toHaveLength(1);
    expect(continued.requests[0]!.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', toolCallId: 'write-once' }),
    );
    expect(await readFile(join(directory, 'workspace/result.txt'), 'utf8')).toBe(
      'Правка человека после остановки',
    );
    expect((await recovered.runtime.usage.status(runId)).runReserved).toBeGreaterThan(
      usageBefore.runReserved,
    );
  },
);

it('после восстановления требует проверки неизвестной записи и закрывает pending без повторения эффектов', async () => {
  const directory = await temporary();
  const configFile = await configDirectory(directory, 'http://127.0.0.1:1/v1');
  const stateDirectory = join(directory, 'state');
  const source = new ScriptedProvider(() =>
    output('', [
      call('written', 'fs.write', { path: 'first.txt', content: 'Первая запись' }),
      call('uncertain', 'fs.uncertain', {}),
    ]),
  );
  const original = await createApplication(configFile, stateDirectory, source);
  cleanup(() => original.close());
  let uncertainWrites = 0;
  original.registry.register({
    definition: {
      name: 'fs.uncertain',
      description: 'Проверочный обрыв после записи',
      schema: { type: 'object', additionalProperties: false },
      effect: 'write',
    },
    async execute() {
      uncertainWrites++;
      await writeFile(join(directory, 'workspace/second.txt'), 'Запись выполнена');
      throw new ToolOutcomeUnknownError('Связь оборвалась после записи');
    },
  });
  const { runId } = await original.runtime.start({
    message: 'Две записи',
    workspace: join(directory, 'workspace'),
    requestKey: 'pending-effects',
  });
  await original.runtime.wait(runId);
  expect(original.sessions.get(runId).status).toBe('paused');
  await original.close();
  await writeFile(join(directory, 'workspace/first.txt'), 'Не повторять первую запись');
  const resumedSource = new ScriptedProvider(() => output('Оба результата учтены'));
  const recovered = await createApplication(configFile, stateDirectory, resumedSource);
  cleanup(() => recovered.close());
  const before = recovered.sessions.get(runId);
  expect(before.agents[before.rootAgentId]!.pending).toHaveLength(2);
  await expect(recovered.runtime.resume(runId)).rejects.toThrow('Resolve unknown');
  expect(recovered.sessions.get(runId)).toEqual(before);
  expect(resumedSource.requests).toHaveLength(0);
  const unknown = Object.values(before.invocations).find((item) => item.status === 'unknown')!;
  await recovered.runtime.resolveInvocation(runId, unknown.id, 'Файл проверен человеком', true);
  await recovered.runtime.resume(runId);
  await recovered.runtime.wait(runId);
  const after = recovered.sessions.get(runId);
  expect(after.status).toBe('completed');
  expect(after.agents[after.rootAgentId]!.pending).toBeUndefined();
  expect(after.fileChanges).toHaveLength(1);
  expect(uncertainWrites).toBe(1);
  expect(await readFile(join(directory, 'workspace/first.txt'), 'utf8')).toBe(
    'Не повторять первую запись',
  );
  expect(await readFile(join(directory, 'workspace/second.txt'), 'utf8')).toBe('Запись выполнена');
  const messages = resumedSource.requests[0]!.messages;
  const pendingIndex = messages.findIndex((message) => message.toolCalls?.length === 2);
  expect(messages.slice(pendingIndex + 1, pendingIndex + 3)).toEqual([
    expect.objectContaining({ role: 'tool', toolCallId: 'written' }),
    expect.objectContaining({
      role: 'tool',
      toolCallId: 'uncertain',
      content: 'Файл проверен человеком',
    }),
  ]);
});

it.each(['mcp', 'reads', 'models', 'learning'] as const)(
  'сохраняет паузу при несовместимых сервисных настройках: %s',
  async (changed) => {
    const source = new ScriptedProvider(() => output('Готово'));
    const app = await harness(source);
    const { runId } = await app.runtime.start({
      message: 'Проверка настроек',
      workspace: app.workspace,
      requestKey: changed,
    });
    await app.runtime.wait(runId);
    await app.sessions.mutate(runId, 'fixture.paused', {}, (run) => {
      run.status = 'paused';
      run.agents[run.rootAgentId]!.status = 'running';
      if (changed === 'mcp')
        run.config.value.tools.mcp = [
          { id: 'old', transport: 'stdio', command: 'unused', args: [], env: {}, tools: {} },
        ];
      if (changed === 'reads') run.config.value.limits.reads++;
      if (changed === 'models') run.config.value.limits.modelConcurrency++;
      if (changed === 'learning') run.config.value.learning.enabled = true;
    });
    const before = app.sessions.get(runId);
    await expect(app.runtime.resume(runId)).rejects.toThrow('original MCP');
    expect(app.sessions.get(runId)).toEqual(before);
    expect(source.requests).toHaveLength(1);
  },
);

it('не запускает второй цикл уже исполняющейся задачи', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const source = new ScriptedProvider(async () => {
    await gate;
    return output('Готово');
  });
  const app = await harness(source);
  const { runId } = await app.runtime.start({
    message: 'Один цикл',
    workspace: app.workspace,
    requestKey: 'one-execution',
  });
  try {
    await eventually(() => source.requests.length === 1);
    await expect(app.runtime.resume(runId)).rejects.toThrow('still stopping');
    expect(source.requests).toHaveLength(1);
  } finally {
    release();
    await app.runtime.wait(runId);
  }
  expect(app.sessions.get(runId).status).toBe('completed');
  await expect(app.runtime.resume(runId)).rejects.toThrow('Only paused');
});
