import { mkdtemp, mkdir, writeFile, rm, stat, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { FileSessionStore } from '../dist/sessions/store.js';
import { configSchema } from '../dist/configuration/schema.js';
import { newAgent } from '../dist/agents/service.js';
import { hash } from '../dist/shared/primitives.js';

/** Измеряет отдельный процесс с тем же деревом данных, включая повторное открытие индексов. */
async function measure(directory, count) {
  const store = new FileSessionStore(directory);
  const started = performance.now();
  await store.initialize();
  if (store.recoveryError) throw new Error(store.recoveryError);
  const coldStartMs = performance.now() - started;
  const durations = [];
  for (let sample = 0; sample < 60; sample++) {
    const started = performance.now();
    const rows = typeof store.catalog === 'function' ? store.catalog() : store.list();
    if (rows.length !== count) throw new Error('Каталог потерял задачи');
    rows.filter((run) => ['running', 'awaiting_approval'].includes(run.status)).length;
    rows.slice(-10);
    durations.push(performance.now() - started);
  }
  durations.sort((a, b) => a - b);
  const report = {
    coldStartMs,
    rssBytes: process.memoryUsage().rss,
    p95Ms: durations[Math.floor(durations.length * 0.95)],
    cache: store.cacheStats?.(),
  };
  if (typeof store.search === 'function') {
    const needle = 'Результат ' + (count - 1);
    const searchStarted = performance.now();
    const found = await store.search(needle);
    report.searchMs = performance.now() - searchStarted;
    if (found.size !== 1) throw new Error('Поиск полного ответа потерял совпадение');
    const cachedStarted = performance.now();
    await store.search(needle);
    report.cachedSearchMs = performance.now() - cachedStarted;
  }
  report.commands = await measureCommands(store, directory, count);
  return report;
}

/** Проверяет реальные обработчики через локальный IPC без создания исполнителей и вызовов модели. */
async function measureCommands(store, directory, count) {
  const { dispatch } = await import('../dist/application/commands/index.js');
  const { parseCommandInput, parseCommandResponse, commandName } = await import(
    '../dist/interfaces/contracts/index.js'
  );
  const { rpc, assertProtocolVersion } = await import('../dist/interfaces/ipc.js');
  const { encodeFrame, IPC_REQUEST_BYTES, IPC_RESPONSE_BYTES } = await import(
    '../dist/interfaces/ipc-limits.js'
  );
  const { privateDirectory, socketPath, createAccessToken, checkAccessToken, removeAccessToken } =
    await import('../dist/interfaces/local-channel.js');
  const { FileApprovalService, PolicyService } = await import('../dist/policy/service.js');
  const { FileLearningStore } = await import('../dist/learning/store.js');
  const { ToolRegistry } = await import('../dist/tools/registry.js');
  const first = store.catalog()[0];
  const learning = new FileLearningStore(directory);
  await learning.initialize({ recover: false });
  const app = {
    directory,
    config: { value: configFor(directory), hash: '' },
    sessions: store,
    runtime: { visibleStatus: (_id, status) => status },
    approvals: new FileApprovalService(store, new PolicyService()),
    learning: { store: learning },
    registry: new ToolRegistry(),
  };
  const address = socketPath(directory);
  await privateDirectory(process.platform === 'win32' ? directory : dirname(address));
  const token = await createAccessToken(directory);
  let historicalLoads = 0;
  const originalLoad = store.load,
    originalHistory = store.history;
  // Открытие переписки ради меню является ошибкой стенда, даже когда запрос укладывается в 200 мс.
  const rejectHistoryRead = () => {
    historicalLoads++;
    throw new Error('Запрос меню попытался открыть журнал переписки');
  };
  store.load = rejectHistoryRead;
  store.history = rejectHistoryRead;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > IPC_REQUEST_BYTES) return socket.destroy();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.pause();
      void (async () => {
        let id = null;
        try {
          const request = JSON.parse(buffer.slice(0, end));
          id = request.id;
          checkAccessToken(token, request.token);
          assertProtocolVersion(request.protocolVersion);
          const method = commandName(request.method);
          const input = parseCommandInput(method, request.params);
          const result = parseCommandResponse(method, await dispatch(app, method, input));
          socket.end(encodeFrame({ jsonrpc: '2.0', id, result }, IPC_RESPONSE_BYTES, 'response'));
        } catch (error) {
          socket.end(
            encodeFrame(
              { jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } },
              IPC_RESPONSE_BYTES,
              'response',
            ),
          );
        }
      })();
    });
  });
  const samples = 60,
    warmups = 5,
    p95Ms = {};
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    if (process.platform !== 'win32') await chmod(address, 0o600);
    for (const method of ['runtime.list', 'runtime.history', 'system.info']) {
      const durations = [];
      for (let sample = -warmups; sample < samples; sample++) {
        const page = Math.max(0, sample) % Math.ceil(count / 10);
        const params =
          method === 'runtime.list'
            ? { offset: page * 10, limit: 10 }
            : method === 'runtime.history'
              ? { page, limit: 10 }
              : {};
        const started = performance.now();
        const result = await rpc(directory, method, params);
        const duration = performance.now() - started;
        if (
          method === 'runtime.list' &&
          (result.length !== 10 || result.some((item) => item.status !== 'completed'))
        )
          throw new Error('Обработчик списка потерял задачи');
        if (
          method === 'runtime.history' &&
          (result.total !== count || result.items.length !== 10 || result.active.length !== 0)
        )
          throw new Error('Обработчик истории потерял задачи или счётчики');
        if (
          method === 'system.info' &&
          (result.activeRuns !== 0 ||
            result.pendingApprovals !== 0 ||
            result.knowledgeCount !== 0 ||
            !result.workspaces.includes(first.workspace))
        )
          throw new Error('Обработчик сведений вернул неверные счётчики');
        if (sample >= 0) durations.push(duration);
      }
      durations.sort((a, b) => a - b);
      p95Ms[method] = durations[Math.floor(durations.length * 0.95)];
    }
    return {
      transport: 'local-ipc',
      samples,
      warmups,
      p95Ms,
      historicalLoads,
      rssBytes: process.memoryUsage().rss,
    };
  } finally {
    store.load = originalLoad;
    store.history = originalHistory;
    await new Promise((resolve) => server.close(resolve));
    await removeAccessToken(directory);
    if (process.platform !== 'win32') await rm(address, { force: true });
  }
}

/** Стенд использует только локальные проверочные настройки без ключей и внешних подключений. */
function configFor(directory) {
  return configSchema.parse({
    schemaVersion: 1,
    basePrompt: 'Проверка хранения',
    rules: [],
    workspaces: [directory],
    defaultRole: 'coordinator',
    coordination: 'manual',
    defaultProfile: 'test',
    profiles: { test: { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' } },
    roles: { coordinator: { prompt: 'Проверка', permissions: [] } },
    policy: { default: 'deny', rules: [] },
    tools: {},
    learning: { enabled: false },
  });
}

/** Считает источники и производные файлы без публикации локальных путей. */
async function storageSize(directory) {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    size += entry.isDirectory() ? await storageSize(path) : (await stat(path)).size;
  }
  return size;
}

if (process.argv[2] === '--existing') {
  console.log(JSON.stringify(await measure(process.argv[3], Number(process.argv[4]))));
  process.exit(0);
}
const count = Number(process.argv[2] ?? 1000);
if (![1000, 10000].includes(count)) throw new Error('Выберите 1000 или 10000 задач.');
const directory = await mkdtemp(join(tmpdir(), 'harness-storage-benchmark-'));
const config = configFor(directory);
const snapshot = { hash: hash(config), value: config };
let bytes = 0;
try {
  await mkdir(join(directory, 'runs'));
  for (let index = 0; index < count; index++) {
    const agent = newAgent('coordinator', 'Задача ' + index);
    agent.status = 'completed';
    agent.messages.push({
      role: 'assistant',
      content: 'Результат ' + index + ' ' + 'я'.repeat(1024),
    });
    const state = {
      schemaVersion: 1,
      id: randomUUID(),
      sessionId: randomUUID(),
      requestKey: 'bench-' + index,
      requestHash: hash(index),
      workspace: directory,
      profile: 'test',
      config: snapshot,
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
    const path = join(directory, 'runs', state.id + '.jsonl');
    await writeFile(
      path,
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
    bytes += (await stat(path)).size;
  }
  const measured = await measure(directory, count);
  const restart = JSON.parse(
    execFileSync(
      process.execPath,
      ['--max-old-space-size=768', import.meta.filename, '--existing', directory, String(count)],
      { encoding: 'utf8' },
    ),
  );
  const report = {
    count,
    node: process.version,
    platform: process.platform,
    ...measured,
    journalBytes: bytes,
    storageBytes: await storageSize(directory),
    restart,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[3])
    await writeFile(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  if (
    process.env.CI &&
    process.platform === 'linux' &&
    [report, report.restart].some((sample) =>
      [sample.p95Ms, ...Object.values(sample.commands.p95Ms)].some((duration) => duration > 200),
    )
  )
    process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
