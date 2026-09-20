import { mkdtemp, mkdir, open, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serve, rpc } from '../dist/interfaces/ipc.js';
import { loadConfig } from '../dist/configuration/loader.js';
import { newAgent } from '../dist/agents/service.js';
import { InsightsService } from '../dist/insights/service.js';
import { hash } from '../dist/shared/primitives.js';

/** Готовит настоящий каталог задач; внешние подключения и обучение отсутствуют. */
async function prepare(root, count, events) {
  const folder = join(root, 'workspace');
  const configuration = join(root, 'config');
  const directory = join(root, 'state');
  await mkdir(folder);
  await mkdir(configuration);
  const files = {
    'base.md': 'Стенд чтения измерений без вызова моделей.',
    'rules.json': [],
    'policy.json': { default: 'deny', rules: [] },
    'roles.json': { coordinator: { prompt: 'base.md', permissions: [] } },
    'profiles.json': { test: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' } },
    'tools.json': {},
    'learning.json': { enabled: false },
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(
      join(configuration, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const configFile = join(configuration, 'harness.json');
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
  let measuredRun;
  for (let index = 0; index < count; index++) {
    const agent = newAgent('coordinator', 'Историческая задача ' + index);
    agent.status = 'completed';
    agent.result = 'Результат ' + index + ' ' + 'я'.repeat(1024);
    agent.messages.push({ role: 'assistant', content: agent.result });
    const state = {
      schemaVersion: 1,
      id: randomUUID(),
      sessionId: randomUUID(),
      requestKey: 'fixture-' + index,
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
      result: agent.result,
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
    measuredRun ??= { runId: state.id, agentId: agent.id };
  }
  await activityFixture(directory, measuredRun, events);
  return { configFile, directory, ...measuredRun };
}

/** Пишет длинную завершённую историю пакетами, не удерживая все события в памяти стенда. */
async function activityFixture(directory, run, count) {
  await mkdir(join(directory, 'activity'));
  const file = await open(join(directory, 'activity', run.runId + '.jsonl'), 'wx', 0o600);
  const common = {
    schemaVersion: 1,
    ...run,
    processId: randomUUID(),
    episodeId: randomUUID(),
    role: 'coordinator',
    profile: 'test',
  };
  let batch = '';
  try {
    for (let index = 0; index < count / 2; index++) {
      const phase = index === 0 ? 'run' : 'model.request';
      const spanId = randomUUID();
      for (const [offset, type] of ['start', 'end'].entries()) {
        const seq = index * 2 + offset + 1;
        batch +=
          JSON.stringify({
            ...common,
            seq,
            at: new Date(1700000000000 + seq).toISOString(),
            type,
            spanId,
            phase,
            ...(type === 'end' ? { durationMs: 1, outcome: 'completed' } : {}),
          }) + '\n';
      }
      if (index % 250 === 249) {
        await file.writeFile(batch);
        batch = '';
      }
    }
    if (batch) await file.writeFile(batch);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Проверяет страницы через тот же IPC, одновременно запрещая меню чтение исторических снимков. */
async function measure(input, count, eventCount) {
  const start = performance.now();
  let modelCalls = 0;
  const server = await serve(input.configFile, input.directory, {
    generate() {
      modelCalls++;
      throw new Error('Модель на стенде запрещена');
    },
  });
  const coldStartMs = performance.now() - start;
  const app = server.app;
  const originals = {
    load: app.sessions.load,
    history: app.sessions.history,
    events: app.projects.store.events,
    get: app.projects.store.get,
    insights: app.insights,
  };
  let historicalMenuReads = 0;
  const rejectHistoryRead = () => {
    historicalMenuReads++;
    throw new Error('Меню открыло историческую переписку');
  };
  // Только выбранный отчёт получает исходный порт; обычные обработчики меню обязаны брать каталог.
  const insights = new InsightsService(input.directory, {
    load: (runId) => originals.load.call(app.sessions, runId),
  });
  app.insights = insights;
  app.sessions.load = rejectHistoryRead;
  app.sessions.history = rejectHistoryRead;
  app.projects.store.events = rejectHistoryRead;
  app.projects.store.get = rejectHistoryRead;
  let running = true;
  let background;
  let backgroundFailure;
  const reads = { insights: 0, activity: 0 };
  let rssPeakBytes = process.memoryUsage().rss;
  const sampleMemory = () => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  };
  const memoryTimer = setInterval(sampleMemory, 25);
  try {
    if (app.sessions.recoveryError || app.projects.store.recoveryError)
      throw new Error('История стенда не восстановилась');
    const readStart = performance.now();
    const initial = await rpc(input.directory, 'runtime.insights', { runId: input.runId });
    const coldActivityMs = performance.now() - readStart;
    if (initial.completeness !== 'complete') throw new Error('Исходные измерения неполны');
    const aggregate = await insights.reader.read(input.runId);
    if (aggregate.index.count !== eventCount || aggregate.data.open.length)
      throw new Error('Нарушена полнота технической истории');
    if (aggregate.index.positions.length > Math.ceil(eventCount / 128))
      throw new Error('Индекс перестал быть разреженным');
    background = (async () => {
      let index = 0;
      while (running) {
        const cursor = (index++ * 997) % (eventCount - 100);
        const [report, page] = await Promise.all([
          rpc(input.directory, 'runtime.insights', { runId: input.runId }),
          rpc(input.directory, 'runtime.activity', { runId: input.runId, cursor, limit: 100 }),
        ]);
        reads.insights++;
        reads.activity++;
        if (report.completeness !== 'complete' || report.agents.length !== 1)
          throw new Error('Отчёт потерял измерения');
        if (
          page.completeness !== 'complete' ||
          page.events.length !== 100 ||
          page.events[0].seq !== cursor + 1 ||
          page.cursor !== cursor + 100
        )
          throw new Error('Нарушен порядок страницы активности');
        const cache = insights.reader.cache.stats();
        if (cache.maximumBytes !== 16 * 1024 * 1024 || cache.bytes > cache.maximumBytes)
          throw new Error('Исторический кэш превышает 16 МиБ');
      }
    })().catch((error) => {
      backgroundFailure = error;
    });
    const p95Ms = {};
    for (const method of ['runtime.list', 'runtime.history', 'projects.list', 'system.info']) {
      const durations = [];
      for (let iteration = -5; iteration < 60; iteration++) {
        const page = Math.max(0, iteration) % 10;
        const params =
          method === 'runtime.list'
            ? { offset: page * 10, limit: 10 }
            : method === 'runtime.history'
              ? { page, limit: 10 }
              : {};
        const before = performance.now();
        const result = await rpc(input.directory, method, params);
        const elapsed = performance.now() - before;
        if (method === 'runtime.list' && result.length !== 10)
          throw new Error('Список потерял задачи');
        if (method === 'runtime.history' && result.total !== count)
          throw new Error('История потеряла задачи');
        if (method === 'projects.list' && result.total !== 0)
          throw new Error('В изолированном состоянии появились чужие проекты');
        if (method === 'system.info' && (result.activeRuns !== 0 || result.pendingApprovals !== 0))
          throw new Error('Счётчики меню неверны');
        if (iteration >= 0) durations.push(elapsed);
        if (backgroundFailure) throw backgroundFailure;
      }
      durations.sort((a, b) => a - b);
      p95Ms[method] = durations[Math.floor(durations.length * 0.95)];
    }
    running = false;
    await background;
    if (backgroundFailure) throw backgroundFailure;
    if (!reads.insights || !reads.activity || historicalMenuReads || modelCalls)
      throw new Error('Стенд не выполнил конкурентную проверку без исторических чтений меню');
    sampleMemory();
    return {
      coldStartMs,
      coldActivityMs,
      p95Ms,
      reads,
      historicalMenuReads,
      modelCalls,
      rssBytes: process.memoryUsage().rss,
      rssPeakBytes,
      cache: insights.reader.cache.stats(),
      indexPositions: aggregate.index.positions.length,
      samples: 60,
      warmups: 5,
    };
  } finally {
    running = false;
    await background;
    clearInterval(memoryTimer);
    Object.assign(app.sessions, { load: originals.load, history: originals.history });
    Object.assign(app.projects.store, { events: originals.events, get: originals.get });
    app.insights = originals.insights;
    await insights.observer.close();
    await server.close();
  }
}

/** Отчёт содержит размер состояния, но не раскрывает пользовательские или временные пути. */
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
const eventCount = 50000;
const root = await mkdtemp(join(tmpdir(), 'harness-insights-'));
try {
  const input = await prepare(root, count, eventCount);
  const report = {
    count,
    eventCount,
    platform: process.platform,
    node: process.version,
    ...(await measure(input, count, eventCount)),
    storageBytes: await size(input.directory),
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3])
    await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  if (
    process.env.CI &&
    process.platform === 'linux' &&
    Object.values(report.p95Ms).some((ms) => ms > 200)
  )
    process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true });
}
