import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createApplication, type Application } from '../src/application/bootstrap.js';
import { dispatch } from '../src/application/commands/index.js';
import { newAgent } from '../src/agents/service.js';
import { parseCommandResponse } from '../src/interfaces/contracts/index.js';
import type { RunRecord } from '../src/sessions/types.js';
import { cleanup, configDirectory, ScriptedProvider, temporary } from './helpers.js';

/** Сохраняет состояние без исполнителя, чтобы переходы каталога были полностью управляемыми. */
async function saveRun(
  app: Application,
  name: string,
  status: RunRecord['status'],
  changes: Partial<RunRecord> = {},
) {
  const agent = newAgent(app.config.value.defaultRole, name);
  await app.sessions.create({
    schemaVersion: 1,
    id: name,
    sessionId: name,
    requestKey: name,
    requestHash: name,
    workspace: app.config.value.workspaces[0]!,
    profile: app.config.value.defaultProfile,
    config: app.config,
    learningVersion: 'baseline',
    status,
    rootAgentId: agent.id,
    agents: { [agent.id]: agent },
    invocations: {},
    approvals: {
      approval: {
        id: 'approval',
        runId: name,
        agentId: agent.id,
        callId: 'write',
        binding: name,
        tool: 'fs.write',
        args: { path: 'sample.txt' },
        reason: 'Требуется разрешение',
        status: 'pending',
      },
    },
    artifacts: [],
    turns: 0,
    handoffs: 0,
    usage: { input: 0, output: 0 },
    createdAt: new Date().toISOString(),
    ...changes,
  });
}

/** Каждый запрос обязан прочитать живые каталоги ровно один раз и не открывать переписки. */
async function readCounters(app: Application, attentionCode?: string) {
  const reads = [
    vi.spyOn(app.sessions, 'catalog'),
    vi.spyOn(app.projects.store, 'catalog'),
    vi.spyOn(app.learning.store, 'read'),
  ];
  const projects = vi.spyOn(app.projects, 'catalog');
  const forbidden = () => {
    throw new Error('Счётчики не должны читать исторические данные');
  };
  const histories = [
    vi.spyOn(app.sessions, 'load').mockImplementation(forbidden),
    vi.spyOn(app.sessions, 'get').mockImplementation(forbidden),
    vi.spyOn(app.sessions, 'history').mockImplementation(forbidden),
    vi.spyOn(app.projects.store, 'get').mockImplementation(forbidden),
    vi.spyOn(app.projects.store, 'events').mockImplementation(forbidden),
  ];
  try {
    const info = parseCommandResponse('system.info', await dispatch(app, 'system.info', {}));
    for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
    for (const history of histories) expect(history).not.toHaveBeenCalled();
    if (attentionCode)
      expect(projects.mock.results[0]?.value).toContainEqual(
        expect.objectContaining({ attention: expect.objectContaining({ code: attentionCode }) }),
      );
    return info;
  } finally {
    for (const spy of [...reads, ...histories, projects]) spy.mockRestore();
  }
}

test('счётчики используют один снимок каталогов, сохраняют фильтры и видят новые состояния', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const app = await createApplication(
    config,
    join(root, 'state'),
    new ScriptedProvider(() => {
      throw new Error('Счётчики не вызывают модель');
    }),
  );
  cleanup(() => app.close());
  const view = await app.projects.create({
    title: 'Текущий проект',
    goal: 'Проверить счётчики',
    workspace: join(root, 'workspace'),
    requestKey: 'project',
  });
  let project = await app.projects.store.get(view.projectId);
  project.status = 'planning';
  project = await app.projects.store.save(project, project.revision, 'fixture', 'Исполнение');
  await app.projects.store.save(
    {
      ...project,
      id: 'archived',
      requestKey: 'archived',
      status: 'paused',
      archivedAt: new Date().toISOString(),
    },
    0,
    'fixture',
    'Архив',
  );
  await saveRun(app, 'running', 'running', { approvals: {} });
  await saveRun(app, 'waiting', 'awaiting_approval', {
    project: { projectId: project.id, kind: 'planning', attempt: 0, planVersion: 1 },
  });
  await saveRun(app, 'paused', 'paused');
  await saveRun(app, 'completed', 'completed');
  await saveRun(app, 'hidden', 'awaiting_approval', { deletedAt: new Date().toISOString() });
  const visible = vi
    .spyOn(app.runtime, 'visibleStatus')
    .mockImplementation((runId, status) => (runId === 'running' ? 'paused' : status));
  try {
    expect(await readCounters(app, 'APPROVAL_REQUIRED')).toMatchObject({
      activeRuns: 1,
      activeProjects: 1,
      projectCount: 1,
      projectsAwaitingDecision: 1,
      pendingApprovals: 2,
      learningVersion: 'baseline',
      knowledgeCount: 0,
    });
    await app.sessions.mutate('waiting', 'fixture', {}, (run) => {
      run.status = 'completed';
    });
    await app.sessions.mutate('paused', 'fixture', {}, (run) => {
      run.approvals.approval!.status = 'allowed';
    });
    project.status = 'completed';
    await app.projects.store.save(project, project.revision, 'fixture', 'Завершение');
    expect(await readCounters(app)).toMatchObject({
      activeRuns: 0,
      activeProjects: 0,
      projectCount: 1,
      projectsAwaitingDecision: 0,
      pendingApprovals: 0,
    });
    app.sessions.requireRecovery('Проверка отказа хранения');
    expect(await readCounters(app, 'STORAGE_UNAVAILABLE')).toMatchObject({
      activeRuns: 0,
      projectsAwaitingDecision: 1,
      pendingApprovals: 0,
      recoveryError: expect.stringContaining('Проверка отказа хранения'),
    });
  } finally {
    visible.mockRestore();
  }
});
