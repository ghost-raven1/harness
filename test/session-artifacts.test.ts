import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileSessionStore } from '../src/sessions/store.js';
import { call, eventually, harness, output, ScriptedProvider } from './helpers.js';

it('продолжение отменённого пакета читает полный прежний результат без повторной записи', async () => {
  let reading = false;
  let writes = 0;
  let artifactId = '';
  const source = new ScriptedProvider((request, index) => {
    if (index === 0)
      return output('', [call('written', 'test.largeWrite', {}), call('waiting', 'test.wait', {})]);
    if (index === 1) {
      const result = request.messages.find((message) => message.toolCallId === 'written')!;
      artifactId = JSON.parse(result.content).artifactId;
      return output('', [
        call('artifact', 'artifacts.read', { id: artifactId, offset: 995, limit: 40 }),
      ]);
    }
    return output('Прежний результат прочитан');
  });
  const app = await harness(source, (config) => {
    config.tools.resultBytes = 256;
  });
  app.registry.register({
    definition: {
      name: 'test.largeWrite',
      effect: 'write',
      description: 'Проверочная запись',
      schema: { type: 'object' },
    },
    async execute() {
      writes++;
      await writeFile(join(app.workspace, 'effect.txt'), 'Записано один раз');
      return { report: 'x'.repeat(1000) + 'FULL_RESULT' };
    },
  });
  app.registry.register({
    definition: {
      name: 'test.wait',
      effect: 'read',
      description: 'Ожидание отмены',
      schema: { type: 'object' },
    },
    async execute(_, context) {
      reading = true;
      await new Promise<void>((_, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('CANCELLED')), {
          once: true,
        });
      });
      return null;
    },
  });
  const first = await app.runtime.start({
    message: 'Создай отчёт',
    workspace: app.workspace,
    requestKey: 'first',
  });
  await eventually(() => reading);
  await app.runtime.cancel(first.runId);
  const next = await app.runtime.start({
    message: 'Прочти полный отчёт',
    workspace: app.workspace,
    sessionId: first.sessionId,
    requestKey: 'next',
  });
  await app.runtime.wait(next.runId);
  const run = app.sessions.get(next.runId);
  expect(run.invocations[run.rootAgentId + ':artifact']?.status).toBe('succeeded');
  expect(
    source.requests[2]!.messages.find((message) => message.toolCallId === 'artifact')?.content,
  ).toContain('FULL_RESULT');
  expect(writes).toBe(1);
  expect(await readFile(join(app.workspace, 'effect.txt'), 'utf8')).toBe('Записано один раз');
  expect(run.artifacts).toEqual([]);
  expect(
    app.sessions.get(first.runId).artifacts.some((artifact) => artifact.id === artifactId),
  ).toBe(true);
});

it('артефакт скрытого этапа доступен после перезапуска только своей беседе и workspace', async () => {
  const app = await harness(new ScriptedProvider(() => output('Готово')));
  const first = await app.runtime.start({
    message: 'Первый этап',
    workspace: app.workspace,
    requestKey: 'first',
  });
  await app.runtime.wait(first.runId);
  const artifactId = await app.sessions.artifact(first.runId, 'PRIVATE_ARTIFACT');
  await app.sessions.mutate(first.runId, 'test.artifact', {}, (run) => {
    run.artifacts.push({ id: artifactId, agentId: run.rootAgentId, callId: 'proof' });
  });
  const next = await app.runtime.start({
    message: 'Продолжение',
    workspace: app.workspace,
    sessionId: first.sessionId,
    requestKey: 'next',
  });
  await app.runtime.wait(next.runId);
  await app.sessions.delete(first.runId);
  const outsider = await app.runtime.start({
    message: 'Чужая беседа',
    workspace: app.workspace,
    requestKey: 'outsider',
  });
  await app.runtime.wait(outsider.runId);
  const otherWorkspace = join(app.directory, 'another-workspace');
  await mkdir(otherWorkspace);
  // Повреждённая или устаревшая запись не должна отменять проверку workspace даже при совпадении sessionId.
  await app.sessions.mutate(outsider.runId, 'test.other_workspace', {}, (run) => {
    run.sessionId = first.sessionId;
    run.workspace = otherWorkspace;
  });
  const otherSession = await app.runtime.start({
    message: 'Отдельная беседа',
    workspace: app.workspace,
    requestKey: 'other-session',
  });
  await app.runtime.wait(otherSession.runId);
  const restored = new FileSessionStore(app.sessions.directory);
  await restored.initialize();
  expect(restored.get(first.runId).deletedAt).toBeTruthy();
  expect(await restored.readArtifact(next.runId, artifactId, 0, 40)).toBe('PRIVATE_ARTIFACT');
  await expect(restored.readArtifact(outsider.runId, artifactId, 0, 40)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(restored.readArtifact(otherSession.runId, artifactId, 0, 40)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const unlisted = await app.sessions.artifact(first.runId, 'UNLISTED_ARTIFACT');
  expect(await app.sessions.readArtifact(first.runId, unlisted, 0, 40)).toBe('UNLISTED_ARTIFACT');
  await expect(app.sessions.readArtifact(next.runId, unlisted, 0, 40)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
