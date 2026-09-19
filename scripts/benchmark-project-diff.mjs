import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serve, rpc } from '../dist/interfaces/ipc.js';
import { loadConfig } from '../dist/configuration/loader.js';
import { resolveCaptureSettings } from '../dist/configuration/project-capture.js';
import { ProjectWorkspace } from '../dist/projects/workspace.js';
import { ProjectChangeService } from '../dist/projects/change-service.js';
import { newAgent } from '../dist/agents/service.js';
import { hash } from '../dist/shared/primitives.js';

/** Создаёт изолированную историю; ни модель, ни команды проекта на стенде не вызываются. */
async function prepare(root, count, attempts) {
  const configDirectory = join(root, 'config');
  const folder = join(root, 'workspace');
  const directory = join(root, 'state');
  await mkdir(configDirectory);
  await mkdir(folder);
  const settings = {
    'base.md': 'Стенд чтения изменений без внешних действий.',
    'rules.json': [],
    'policy.json': { default: 'deny', rules: [{ tool: 'fs.read', decision: 'allow' }] },
    'roles.json': {
      coordinator: { prompt: 'base.md', permissions: [{ tool: 'fs.read', decision: 'allow' }] },
    },
    'profiles.json': { test: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' } },
    'tools.json': {},
    'learning.json': { enabled: false },
  };
  for (const [name, value] of Object.entries(settings))
    await writeFile(
      join(configDirectory, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const configFile = join(configDirectory, 'harness.json');
  await writeFile(
    configFile,
    JSON.stringify({
      schemaVersion: 1,
      basePrompt: 'base.md',
      rules: 'rules.json',
      policy: 'policy.json',
      roles: 'roles.json',
      profiles: 'profiles.json',
      tools: 'tools.json',
      learning: 'learning.json',
      defaultRole: 'coordinator',
      defaultProfile: 'test',
      coordination: 'manual',
      workspaces: ['../workspace'],
    }),
  );
  const config = await loadConfig(configFile);
  await mkdir(join(directory, 'runs'), { recursive: true });
  for (let index = 0; index < count; index++) {
    const agent = newAgent('coordinator', 'Историческая задача ' + index);
    agent.status = 'completed';
    agent.messages.push({
      role: 'assistant',
      content: 'Результат ' + index + ' ' + 'я'.repeat(1024),
    });
    const state = {
      schemaVersion: 1,
      id: randomUUID(),
      sessionId: randomUUID(),
      requestKey: 'history-' + index,
      requestHash: hash(index),
      workspace: folder,
      profile: 'test',
      config,
      learningVersion: 'baseline',
      status: 'completed',
      rootAgentId: agent.id,
      agents: { [agent.id]: agent },
      invocations: {},
      approvals: {},
      artifacts: [],
      turns: 1,
      handoffs: 0,
      usage: { input: 10, output: 5 },
      createdAt: new Date(1700000000000 + index).toISOString(),
      result: agent.messages.at(-1).content,
    };
    await writeFile(
      join(directory, 'runs', state.id + '.jsonl'),
      [1, 2, 3, 4]
        .map(
          (seq) =>
            JSON.stringify({
              seq,
              at: state.createdAt,
              type: 'run.completed',
              payload: {},
              state,
            }) + '\n',
        )
        .join(''),
    );
  }
  const workspace = new ProjectWorkspace(directory);
  const projectId = randomUUID();
  const capture = resolveCaptureSettings();
  const options = { settings: capture, config: config.value };
  // Сложный файл заставляет worker реально вычислять сравнение, пока меню отвечает по каталогу.
  const version = (prefix) =>
    Array.from({ length: 12_000 }, (_, index) => prefix + index).join('\n');
  await writeFile(join(folder, 'calculation.ts'), version('before-'));
  const before = await workspace.capture(projectId, folder, [], options);
  await writeFile(join(folder, 'calculation.ts'), version('after-'));
  const after = await workspace.capture(projectId, folder, [], options);
  const stage = {
    id: 'implementation',
    title: 'Реализация',
    task: 'Стенд',
    role: 'coordinator',
    dependsOn: [],
    expectedResult: 'Проверка',
    requiredTools: [],
    verification: { kind: 'manual', instructions: 'Стенд' },
  };
  const project = {
    schemaVersion: 1,
    id: projectId,
    revision: 1,
    requestKey: 'project-fixture',
    requestHash: hash('project'),
    title: 'Длинная история исправлений',
    goal: 'Измерить чтение',
    workspace: folder,
    profile: 'test',
    status: 'cancelled',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    learningVersion: 'baseline',
    capture,
    plan: { version: 1, stages: [stage], maxCorrections: 2, fixBaselineFailures: false },
    stages: {
      implementation: {
        stageId: stage.id,
        status: 'pending',
        attempt: 0,
        definitionHash: hash(stage),
      },
    },
    runIds: [],
    reports: [],
    phase: 'stages',
    receipts: {},
    changeSets: [],
  };
  await mkdir(join(directory, 'project-records'));
  const rows = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    project.changeSets.push({
      id: 'attempt-' + attempt,
      kind: 'stage',
      outcome: 'complete',
      planVersion: 1,
      stageId: stage.id,
      stageTitle: stage.title,
      attempt,
      before,
      after,
    });
    project.revision = attempt + 1;
    rows.push(
      JSON.stringify({
        schemaVersion: 1,
        seq: project.revision,
        at: project.updatedAt,
        type: 'project.fixture',
        message: 'Сохранённая попытка',
        state: project,
      }) + '\n',
    );
  }
  await writeFile(join(directory, 'project-records', projectId + '.jsonl'), rows.join(''));
  return { configFile, directory, projectId };
}

/** Измеряет настоящий IPC одновременно с тяжёлыми diff; меню не получает доступ к истории. */
async function measure(input, count, attempts) {
  const started = performance.now();
  const server = await serve(input.configFile, input.directory, {
    generate: () => {
      throw new Error('Модель запрещена');
    },
  });
  const app = server.app;
  const coldStartMs = performance.now() - started;
  if (app.sessions.recoveryError || app.projects.store.recoveryError) {
    await server.close();
    throw new Error('Стенд не восстановился');
  }
  const saved = {
    load: app.sessions.load,
    history: app.sessions.history,
    events: app.projects.store.events,
    get: app.projects.store.get,
    catalog: app.projects.store.catalog,
  };
  let historicalLoads = 0;
  let running = true;
  let comparisons = 0;
  let limited = 0;
  const denied = () => {
    historicalLoads++;
    throw new Error('Меню открыло исторический журнал');
  };
  app.sessions.load = denied;
  app.sessions.history = denied;
  app.projects.store.events = denied;
  // Читатель выбранного diff получает исходный порт; всем обработчикам меню история запрещена.
  const changes = new ProjectChangeService({
    readProject: (projectId) => saved.get.call(app.projects.store, projectId),
    workspace: app.projects.coordinator.options.workspace,
    content: app.projects.coordinator.options.workspace.content,
  });
  app.projectChanges = changes;
  app.projects.store.get = denied;
  const p95Ms = {};
  let backgroundFailure;
  const readDiffs = (async () => {
    let index = 0;
    while (running) {
      const changeSetId = 'attempt-' + (index++ % attempts);
      const page = await rpc(input.directory, 'projects.changes', {
        projectId: input.projectId,
        changeSetId,
      });
      const file = page.items[0];
      if (!file) throw new Error('Стенд потерял изменённый файл');
      const output = await rpc(input.directory, 'projects.fileChange', {
        projectId: input.projectId,
        changeSetId,
        fileId: file.fileId,
        view: 'diff',
      });
      comparisons++;
      if (output.state === 'limited') limited++;
      else if (output.state !== 'available') throw new Error('Копия недоступна');
      const cache = app.projectChanges.worker.stats();
      if (cache.bytes > cache.maximumBytes) throw new Error('Кэш превысил 16 МиБ');
    }
  })().catch((error) => {
    backgroundFailure = error;
  });
  try {
    for (const method of ['runtime.list', 'runtime.history', 'projects.list', 'system.info']) {
      const durations = [];
      for (let iteration = -5; iteration < 60; iteration++) {
        const page = Math.max(0, iteration) % 10;
        const params =
          method === 'runtime.list'
            ? { offset: page * 10, limit: 10 }
            : method === 'runtime.history'
              ? { page, limit: 10 }
              : method === 'projects.list'
                ? {}
                : {};
        const before = performance.now();
        const result = await rpc(input.directory, method, params);
        const elapsed = performance.now() - before;
        if (method === 'runtime.history' && result.total !== count)
          throw new Error('Неверное число задач');
        if (method === 'projects.list' && result.total !== 1)
          throw new Error('Неверное число проектов');
        if (iteration >= 0) durations.push(elapsed);
        if (backgroundFailure) throw backgroundFailure;
      }
      durations.sort((a, b) => a - b);
      p95Ms[method] = durations[Math.floor(durations.length * 0.95)];
    }
    running = false;
    await readDiffs;
    if (backgroundFailure) throw backgroundFailure;
    return {
      coldStartMs,
      p95Ms,
      historicalLoads,
      comparisons,
      limited,
      rssBytes: process.memoryUsage().rss,
      cache: app.projectChanges.worker.stats(),
    };
  } finally {
    running = false;
    await readDiffs;
    Object.assign(app.sessions, { load: saved.load, history: saved.history });
    Object.assign(app.projects.store, {
      get: saved.get,
      events: saved.events,
      catalog: saved.catalog,
    });
    await changes.close();
    await server.close();
    if (backgroundFailure) throw backgroundFailure;
  }
}

/** Размеры используются только в отчёте стенда, без раскрытия временных путей. */
async function size(directory) {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    bytes += entry.isDirectory() ? await size(path) : (await stat(path)).size;
  }
  return bytes;
}
const count = Number(process.argv[2] ?? 10000);
if (![1000, 10000].includes(count)) throw new Error('Выберите 1000 или 10000 задач.');
const attempts = 100;
const root = await mkdtemp(join(tmpdir(), 'harness-project-diff-'));
try {
  const input = await prepare(root, count, attempts);
  const report = {
    count,
    attempts,
    platform: process.platform,
    node: process.version,
    ...(await measure(input, count, attempts)),
    storageBytes: await size(input.directory),
  };
  if (!report.comparisons) throw new Error('Измерение прошло без одновременного сравнения');
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3])
    await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  if (
    process.env.CI &&
    process.platform === 'linux' &&
    Object.values(report.p95Ms).some((time) => time > 200)
  )
    process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
