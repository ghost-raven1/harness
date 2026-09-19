import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../dist/application/bootstrap.js';
import { dispatch } from '../dist/application/commands/index.js';
import { parseCommandInput, parseCommandResponse } from '../dist/interfaces/contracts/index.js';
import { loadConfig } from '../dist/configuration/loader.js';
import { hash } from '../dist/shared/primitives.js';

/** Стенд пишет только временные проекты; модель и проверочные команды никогда не запускаются. */
async function prepare(directory, count) {
  const configDirectory = join(directory, 'config');
  await mkdir(configDirectory);
  await mkdir(join(directory, 'workspace'));
  const settings = {
    'base.md': 'Локальный стенд без внешних действий.',
    'rules.json': [],
    'policy.json': { default: 'deny', rules: [] },
    'roles.json': { coordinator: { prompt: 'base.md', permissions: [] } },
    'profiles.json': { test: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' } },
    'tools.json': {},
    'learning.json': { enabled: false },
  };
  for (const [name, value] of Object.entries(settings))
    await writeFile(
      join(configDirectory, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const manifest = {
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
  };
  const configFile = join(configDirectory, 'harness.json');
  await writeFile(configFile, JSON.stringify(manifest));
  const config = await loadConfig(configFile);
  const folder = join(directory, 'state', 'project-records');
  await mkdir(folder, { recursive: true });
  const stage = {
    id: 'implementation',
    title: 'Разработка',
    task: 'Задача этапа',
    role: 'coordinator',
    dependsOn: [],
    expectedResult: 'Изменение проверено',
    requiredTools: [],
    verification: { kind: 'manual', instructions: 'Проверьте поведение вручную.' },
  };
  for (let index = 0; index < count; index++) {
    const project = {
      schemaVersion: 1,
      id: randomUUID(),
      revision: 1,
      requestKey: 'bench-' + index,
      requestHash: hash(index),
      title: 'Проект ' + index,
      goal: 'Цель ' + index,
      workspace: config.value.workspaces[0],
      profile: 'test',
      status: index % 2 ? 'ready' : 'draft',
      createdAt: new Date(1700000000000 + index).toISOString(),
      updatedAt: new Date(1700000000000 + index).toISOString(),
      config,
      learningVersion: 'baseline',
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
      phase: 'planning',
      receipts: {},
    };
    // Несколько записей выявляют случайное чтение полного журнала при каждом обновлении меню.
    const rows = Array.from({ length: 4 }, (_, offset) => ({
      schemaVersion: 1,
      seq: offset + 1,
      at: project.updatedAt,
      type: 'project.fixture',
      message: 'Стенд',
      state: { ...project, revision: offset + 1 },
    }));
    await writeFile(
      join(folder, project.id + '.jsonl'),
      rows.map((row) => JSON.stringify(row) + '\n').join(''),
    );
  }
  return configFile;
}

/** Запрещает загрузку истории во время измерения реальных типизированных обработчиков меню. */
async function measure(configFile, state, count) {
  const started = performance.now();
  const app = await createApplication(configFile, state, {
    generate: () => {
      throw new Error('Модель запрещена');
    },
  });
  const coldStartMs = performance.now() - started;
  if (app.sessions.recoveryError || app.projects.store.recoveryError)
    throw new Error('Ошибка восстановления стенда');
  let historicalLoads = 0;
  const saved = {
    get: app.projects.store.get,
    events: app.projects.store.events,
    load: app.sessions.load,
    history: app.sessions.history,
  };
  const reject = () => {
    historicalLoads++;
    throw new Error('Меню загрузило историю');
  };
  app.projects.store.get = reject;
  app.projects.store.events = reject;
  app.sessions.load = reject;
  app.sessions.history = reject;
  const p95Ms = {};
  try {
    for (const method of ['projects.list', 'system.info']) {
      const times = [];
      for (let iteration = -5; iteration < 60; iteration++) {
        const attentionOnly = iteration % 2 === 0;
        const params = parseCommandInput(
          method,
          method === 'projects.list' ? { attentionOnly, page: Math.max(0, iteration) % 5 } : {},
        );
        const before = performance.now();
        const result = parseCommandResponse(method, await dispatch(app, method, params));
        const elapsed = performance.now() - before;
        if (
          method === 'projects.list' &&
          (result.attentionCount !== count / 2 ||
            result.total !== (attentionOnly ? count / 2 : count))
        )
          throw new Error('Список потерял проекты или ожидающие решения');
        if (
          method === 'system.info' &&
          (result.projectCount !== count || result.projectsAwaitingDecision !== count / 2)
        )
          throw new Error('Неверный счётчик проектов');
        if (iteration >= 0) times.push(elapsed);
      }
      times.sort((a, b) => a - b);
      p95Ms[method] = times[Math.floor(times.length * 0.95)];
    }
    return {
      coldStartMs,
      p95Ms,
      historicalLoads,
      rssBytes: process.memoryUsage().rss,
      evidenceCache: app.projectEvidence?.cacheStats(),
    };
  } finally {
    app.projects.store.get = saved.get;
    app.projects.store.events = saved.events;
    app.sessions.load = saved.load;
    app.sessions.history = saved.history;
    await app.close();
  }
}
async function bytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return total;
}
const count = Number(process.argv[2] ?? 100);
if (![100, 1000].includes(count)) throw new Error('Выберите 100 или 1000 проектов.');
const directory = await mkdtemp(join(tmpdir(), 'harness-project-benchmark-'));
try {
  const configFile = await prepare(directory, count),
    state = join(directory, 'state');
  const first = await measure(configFile, state, count);
  const restart = await measure(configFile, state, count);
  const report = {
    count,
    platform: process.platform,
    node: process.version,
    ...first,
    restart,
    storageBytes: await bytes(state),
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3])
    await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  if (
    process.env.CI &&
    process.platform === 'linux' &&
    [first, restart].some((item) => Object.values(item.p95Ms).some((time) => time > 200))
  )
    process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
