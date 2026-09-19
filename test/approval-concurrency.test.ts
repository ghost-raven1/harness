import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, eventually, harness, output, ScriptedProvider } from './helpers.js';

it.each(['allow', 'deny', 'cancel'] as const)(
  'ожидание разрешения не останавливает другую задачу; решение: %s',
  async (decision) => {
    const provider = new ScriptedProvider((request) => {
      if (request.messages.some((item) => item.role === 'tool')) return output('Готово');
      return request.messages.some((item) => item.content === 'Независимая задача')
        ? output('', [
            call('other-write', 'fs.write', {
              path: 'other.txt',
              content: 'Независимый результат',
            }),
            call('other-read', 'fs.read', { path: 'other.txt' }),
          ])
        : output('', [
            call('ask', 'fixture.approval', {}),
            call('after-write', 'fs.read', { path: 'result.txt' }),
          ]);
    });
    const app = await harness(provider, (config) => {
      config.policy.rules.push({ tool: 'fixture.approval', decision: 'ask', args: {} });
    });
    let writes = 0;
    const path = join(app.workspace, 'result.txt');
    await writeFile(path, 'До записи');
    app.registry.register({
      definition: {
        name: 'fixture.approval',
        description: 'Запись после решения человека',
        schema: { type: 'object' },
        effect: 'write',
      },
      async execute() {
        writes++;
        await writeFile(path, 'После записи');
        return { written: true };
      },
    });
    const waiting = await app.runtime.start({
      message: 'Нужно разрешение',
      workspace: app.workspace,
      requestKey: 'waiting',
    });
    try {
      await eventually(() => app.approvals.pending().length === 1);
      const other = await app.runtime.start({
        message: 'Независимая задача',
        workspace: app.workspace,
        requestKey: 'independent',
      });
      await eventually(() => app.sessions.get(other.runId).status === 'completed');
      expect(await readFile(join(app.workspace, 'other.txt'), 'utf8')).toBe(
        'Независимый результат',
      );
      expect(app.sessions.get(waiting.runId).status).toBe('awaiting_approval');
      expect(Object.keys(app.sessions.get(waiting.runId).invocations)).toHaveLength(0);
      expect(writes).toBe(0);
      if (decision === 'cancel') await app.runtime.cancel(waiting.runId);
      else await app.approvals.resolve(app.approvals.pending()[0]!.id, decision === 'allow');
      await app.runtime.wait(waiting.runId);
      expect(writes).toBe(decision === 'allow' ? 1 : 0);
      expect(await readFile(path, 'utf8')).toBe(
        decision === 'allow' ? 'После записи' : 'До записи',
      );
      const run = app.sessions.get(waiting.runId);
      expect(run.status).toBe(decision === 'cancel' ? 'cancelled' : 'completed');
      const read = Object.values(run.invocations).find((item) => item.call.id === 'after-write');
      if (decision === 'cancel') expect(read?.status).toBe('cancelled');
      else expect(read?.result).toContain(decision === 'allow' ? 'После записи' : 'До записи');
      expect(app.approvals.pending()).toHaveLength(0);
    } finally {
      await app.runtime.cancel(waiting.runId);
    }
  },
);

it('ожидающие разрешения чтения не занимают все места общего диспетчера', async () => {
  const provider = new ScriptedProvider((request) => {
    if (request.messages.some((item) => item.role === 'tool')) return output('Готово');
    return request.messages.some((item) => item.content === 'Независимая задача')
      ? output('', [call('other', 'fs.list', { path: '.' })])
      : output('', [call('ask', 'fixture.approval', {})]);
  });
  const app = await harness(provider, (config) => {
    config.limits.reads = 1;
    config.policy.rules.push({ tool: 'fixture.approval', decision: 'ask', args: {} });
  });
  let reads = 0;
  app.registry.register({
    definition: {
      name: 'fixture.approval',
      description: 'Чтение после решения человека',
      schema: { type: 'object' },
      effect: 'read',
    },
    async execute() {
      reads++;
      return { read: true };
    },
  });
  const waiting = await app.runtime.start({
    message: 'Нужно разрешение',
    workspace: app.workspace,
    requestKey: 'waiting-read',
  });
  try {
    await eventually(() => app.approvals.pending().length === 1);
    const other = await app.runtime.start({
      message: 'Независимая задача',
      workspace: app.workspace,
      requestKey: 'other-read',
    });
    await eventually(() => app.sessions.get(other.runId).status === 'completed');
    expect(reads).toBe(0);
    await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
    await app.runtime.wait(waiting.runId);
    expect(app.sessions.get(waiting.runId).status).toBe('completed');
    expect(reads).toBe(1);
  } finally {
    await app.runtime.cancel(waiting.runId);
  }
});

it('специалист завершает чтение, пока другая ветка ждёт разрешения записи', async () => {
  let app!: Awaited<ReturnType<typeof harness>>;
  const provider = new ScriptedProvider(async (request) => {
    const hasTask = (task: string) =>
      request.messages.some((item) => item.role === 'user' && item.content === task);
    const hasResult = request.messages.some((item) => item.role === 'tool');
    if (hasTask('Запиши с разрешением'))
      return hasResult
        ? output('Записано')
        : output('', [call('write', 'fs.write', { path: 'written.txt', content: 'Новый файл' })]);
    if (hasTask('Прочитай независимо')) {
      if (hasResult) return output('Прочитано');
      await eventually(() => app.approvals.pending().length === 1);
      return output('', [call('read', 'fs.read', { path: 'sample.txt' })]);
    }
    return hasResult
      ? output('Обе ветки учтены')
      : output('', [
          call('writer', 'agents.delegate', { role: 'worker', task: 'Запиши с разрешением' }),
          call('reader', 'agents.delegate', { role: 'reader', task: 'Прочитай независимо' }),
        ]);
  });
  app = await harness(provider, (config) => {
    config.policy.rules.push({ tool: 'fs.write', decision: 'ask', args: {} });
  });
  await writeFile(join(app.workspace, 'sample.txt'), 'Данные для чтения');
  const { runId } = await app.runtime.start({
    message: 'Две независимые ветки',
    workspace: app.workspace,
    requestKey: 'parallel-approval',
  });
  try {
    await eventually(() =>
      Object.values(app.sessions.get(runId).agents).some(
        (agent) => agent.task === 'Прочитай независимо' && agent.status === 'completed',
      ),
    );
    expect(app.sessions.get(runId).status).toBe('awaiting_approval');
    const approval = app.approvals.pending()[0]!;
    expect(approval.tool).toBe('fs.write');
    await app.approvals.resolve(approval.id, true);
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.status).toBe('completed');
    expect(Object.values(run.agents).map((agent) => agent.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(await readFile(join(app.workspace, 'written.txt'), 'utf8')).toBe('Новый файл');
  } finally {
    await app.runtime.cancel(runId);
  }
});
