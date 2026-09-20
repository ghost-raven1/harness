import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApplication } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import {
  configDirectory,
  temporary,
  cleanup,
  ScriptedProvider,
  output,
  call,
  eventually,
  fixtureConfig,
} from './helpers.js';
import type { ModelProvider } from '../src/providers/types.js';

/** Создаёт настоящее приложение в отдельном состоянии с измеряемым тестовым провайдером. */
async function application(provider: ModelProvider, ask = false) {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const fixture = fixtureConfig(join(root, 'workspace'));
  if (ask) fixture.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
  for (const [name, role] of Object.entries(fixture.roles)) {
    await writeFile(join(root, 'config', name + '.md'), role.prompt);
    role.prompt = name + '.md';
  }
  await writeFile(join(root, 'config/roles.json'), JSON.stringify(fixture.roles));
  await writeFile(join(root, 'config/policy.json'), JSON.stringify(fixture.policy));
  const app = await createApplication(config, join(root, 'state'), provider);
  cleanup(() => app.close());
  return { app, root, workspace: join(root, 'workspace') };
}

it('регистрирует дерево, инструмент, implicit await и handoff без текста задачи в метриках', async () => {
  const provider = new ScriptedProvider((request) => {
    const role = /ACTIVE ROLE: (\w+)/.exec(request.messages[0]!.content)?.[1];
    const tools = request.messages.filter((message) => message.role === 'tool');
    const result =
      role === 'coordinator' && !tools.length
        ? output('', [
            call('delegate', 'agents.delegate', {
              role: 'worker',
              task: 'Секретное поручение дочернему',
              context: '',
            }),
          ])
        : role === 'worker' && !tools.length
          ? output('', [
              call('write', 'fs.write', { path: 'result.txt', content: 'PRIVATE_TOOL_ARGUMENT' }),
            ])
          : role === 'worker'
            ? output('', [
                call('handoff', 'agents.handoff', { role: 'reader', reason: 'Проверить файл' }),
              ])
            : output('PRIVATE_MODEL_RESULT');
    return { ...result, usageSource: 'provider' };
  });
  const { app, workspace } = await application(provider);
  const { runId } = await app.runtime.start({
    message: 'PRIVATE_USER_TASK',
    workspace,
    requestKey: 'insights-tree',
  });
  await app.runtime.wait(runId);
  const report = await app.insights.report(runId);
  expect(report.status).toBe('completed');
  expect(report.agents).toHaveLength(2);
  expect(report.roles.some((role) => role.role === 'worker')).toBe(true);
  expect(report.roles.some((role) => role.role === 'reader')).toBe(true);
  expect(report.roles.some((role) => (role.phases.children ?? 0) > 0)).toBe(true);
  expect(report.roles.some((role) => (role.phases['tool.execute'] ?? 0) > 0)).toBe(true);
  expect(report.usage.provider.requests).toBe(provider.requests.length);
  const journal = await readFile(app.insights.reader.path(runId), 'utf8');
  expect(journal).not.toMatch(/PRIVATE_|Секретное|Проверить файл/);
  expect(journal).not.toContain(workspace);
  expect(report.completeness).toBe('complete');
  const info = (await dispatch(app, 'system.info', {})) as { capabilities: string[] };
  expect(info.capabilities).toContain('execution-insights-v1');
});

it('ожидание человека видно до решения, затем отмена закрывает интервалы', async () => {
  const provider = new ScriptedProvider(() =>
    output('', [call('write', 'fs.write', { path: 'approval.txt', content: 'x' })]),
  );
  const { app, workspace } = await application(provider, true);
  const { runId } = await app.runtime.start({
    message: 'ask',
    workspace,
    requestKey: 'insights-ask',
  });
  await eventually(() => app.approvals.pending().length > 0);
  const during = await app.insights.report(runId);
  expect(during.agents[0]!.phases).toContain('approval');
  await app.runtime.cancel(runId);
  await app.runtime.wait(runId);
  const report = await app.insights.report(runId);
  expect(report.status).toBe('cancelled');
  expect(report.agents[0]!.phases).toEqual([]);
  expect(report.roles[0]!.phases.approval).toBeGreaterThan(0);
});

it('сжатие контекста имеет отдельный requestId и входит в учёт запросов', async () => {
  let replies = 0;
  const provider = new ScriptedProvider((request) => {
    if (request.messages[0]!.content.startsWith('Summarize'))
      return { ...output('Краткий итог'), usageSource: 'provider' };
    return {
      ...(++replies <= 3
        ? output('x'.repeat(26000), [call('list' + replies, 'fs.list', { path: '.' })])
        : output('Готово')),
      usageSource: 'provider',
    };
  });
  const { app, workspace } = await application(provider);
  const { runId } = await app.runtime.start({
    message: 'Длинная история',
    workspace,
    requestKey: 'insights-compaction',
  });
  await app.runtime.wait(runId);
  const report = await app.insights.report(runId);
  expect(report.status).toBe('completed');
  expect(report.roles.some((role) => (role.phases.compaction ?? 0) > 0)).toBe(true);
  expect(report.usage.provider.requests).toBe(provider.requests.length);
  const events = (await app.insights.activity(runId, 0, 100)).events;
  const compact = events.find((event) => event.phase === 'compaction');
  expect(compact?.requestId).toBeTruthy();
  expect(
    events.some((event) => event.requestId === compact!.requestId && event.type === 'usage'),
  ).toBe(true);
});

it('полное удаление очищает журнал, индексы и кэши; старый запрос отчёта недоступен', async () => {
  const { app, workspace } = await application(new ScriptedProvider(() => output('Готово')));
  const { runId } = await app.runtime.start({
    message: 'done',
    workspace,
    requestKey: 'insights-purge',
  });
  await app.runtime.wait(runId);
  await app.insights.report(runId);
  const preview = await app.purge.preview(runId);
  expect(preview.available).toBe(true);
  await app.purge.purge(runId, preview.previewToken);
  await expect(readFile(app.insights.reader.path(runId))).rejects.toHaveProperty('code', 'ENOENT');
  expect(app.insights.reader.cache.stats().entries).toBe(0);
  await expect(app.insights.report(runId)).rejects.toThrow();
});

it('полный ответ дочернего специалиста читается страницами без тихого обрезания', async () => {
  const text = 'я'.repeat(20000);
  const { app, workspace } = await application(new ScriptedProvider(() => output(text)));
  const { runId } = await app.runtime.start({
    message: 'long result',
    workspace,
    requestKey: 'insights-pages',
  });
  await app.runtime.wait(runId);
  const first = await app.insights.report(runId, app.sessions.get(runId).rootAgentId);
  expect(first.agents[0]!.resultTruncated).toBe(true);
  const next = await app.insights.report(runId, first.agents[0]!.id, 16384);
  expect(first.agents[0]!.result! + next.agents[0]!.result).toBe(text);
  expect(next.agents[0]!.resultTruncated).toBe(false);
});
