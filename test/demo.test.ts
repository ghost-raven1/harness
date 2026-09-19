import { expect, test } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startDemoSession } from '../src/interfaces/commands/demo.js';
import {
  DemoProvider,
  demoCorrect,
  demoGoal,
  demoSource,
  demoTitle,
} from '../src/providers/demo-provider.js';
import { cleanup, eventually, fixtureConfig } from './helpers.js';
import { mutation } from './project-helpers.js';
import type { ModelRequest } from '../src/providers/types.js';

test('демо проходит реальный IPC, ошибочную попытку, тест, исправление и приёмку без сети', async () => {
  const session = await startDemoSession();
  cleanup(session.close);
  const request = session.request;
  let project = await request('projects.create', {
    title: demoTitle,
    goal: demoGoal,
    workspace: session.workspace,
    profile: 'demo',
    requestKey: 'create-demo',
  });
  await request('projects.plan', mutation(project));
  await eventually(async () => {
    project = await request('projects.detail', { projectId: project.projectId });
    return project.status !== 'planning';
  });
  expect(project.status, project.reason).toBe('ready');
  expect(await readFile(join(session.workspace, 'price.js'), 'utf8')).toBe(demoSource);
  await request('projects.acceptPlan', {
    ...mutation(project),
    expectedPlanVersion: project.planVersion!,
  });
  await eventually(async () => {
    project = await request('projects.detail', { projectId: project.projectId });
    return !['running', 'pausing'].includes(project.status);
  }, 20000);
  expect(project.status, JSON.stringify(project)).toBe('review');
  expect(project.reports.map((report) => report.status)).toEqual([
    'failed',
    'failed',
    'passed',
    'passed',
  ]);
  expect(await readFile(join(session.workspace, 'price.js'), 'utf8')).toBe(demoCorrect);
  const review = await request('projects.review', { projectId: project.projectId });
  expect(review.canAccept, review.blockers.join('\n')).toBe(true);
  project = await request('projects.accept', {
    ...mutation(project),
    expectedResultRevision: project.resultRevision!,
  });
  expect(project.status).toBe('completed');
  const command = session.service.app.registry.get('process.exec');
  await expect(
    command.execute(
      { command: process.execPath, args: ['-e', 'process.exit()'] },
      {
        runId: 'demo-test',
        workspace: session.workspace,
        config: fixtureConfig(session.workspace),
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow('только проверка');
  await session.close();
  await expect(access(session.root)).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

test('новый экземпляр учебного провайдера восстанавливает шаг из истории и отклоняет другую задачу', async () => {
  const request: ModelRequest = {
    profile: fixtureConfig('/tmp').profiles.test!,
    tools: [],
    messages: [
      { role: 'system', content: 'Учебный режим' },
      { role: 'user', content: demoGoal },
    ],
  };
  const read = await new DemoProvider().generate(request);
  request.messages.push(
    { role: 'assistant', content: read.text, toolCalls: read.calls },
    {
      role: 'tool',
      content: JSON.stringify({ content: demoSource }),
      toolCallId: read.calls[0]!.id,
    },
  );
  const write = await new DemoProvider().generate(request);
  expect(write.calls[0]?.name).toBe('fs.write');
  request.messages.push(
    { role: 'assistant', content: write.text, toolCalls: write.calls },
    {
      role: 'tool',
      content: 'Записано',
      toolCallId: write.calls[0]!.id,
    },
  );
  expect((await new DemoProvider().generate(request)).finish).toBe('stop');
  request.messages.push({ role: 'user', content: 'Сделай произвольную задачу' });
  const unsupported = await new DemoProvider().generate(request);
  expect(unsupported.calls).toEqual([]);
  expect(unsupported.text).toContain('только сценарий');
});

test('учебный провайдер не объявляет неудачную запись успешной и не принимает одну фразу исправления за учебную цель', async () => {
  const request: ModelRequest = {
    profile: fixtureConfig('/tmp').profiles.test!,
    tools: [],
    messages: [
      { role: 'user', content: demoGoal },
      {
        role: 'assistant',
        content: 'Чтение',
        toolCalls: [{ id: 'read', name: 'fs.read', arguments: '{"path":"price.js"}' }],
      },
      { role: 'tool', toolCallId: 'read', content: '{"error":"ENOENT"}' },
    ],
  };
  const failed = await new DemoProvider().generate(request);
  expect(failed.calls).toEqual([]);
  expect(failed.text).toContain('ошибкой');
  request.messages = [
    { role: 'user', content: 'Обязательная проверка не прошла. Измени произвольный файл.' },
  ];
  expect((await new DemoProvider().generate(request)).calls).toEqual([]);
});
