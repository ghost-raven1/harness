/** Изолированный владелец состояния для PTY: только тестовые данные и управляемый провайдер. */
import { createServer } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedScreenInventory } from './screen-inventory-seeds.mjs';

const [root, config, directory] = process.argv.slice(2);
const moduleAt = (path) => import(pathToFileURL(resolve(root, 'dist', path)).href);
const { createApplication } = await moduleAt('interfaces/application.js');
const { dispatch } = await moduleAt('interfaces/routes.js');
const { acquireLock, socketPath } = await moduleAt('interfaces/ipc.js');
const { resourceErrorData } = await moduleAt('shared/resource-errors.js');
const { applicationErrorData } = await moduleAt('shared/application-error.js');
const waiting = new Set();
const release = await acquireLock(directory);
const app = await createApplication(config, directory, {
  generate(request) {
    return new Promise((complete, reject) => {
      if (request.signal?.aborted) return reject(request.signal.reason);
      const entry = { request, complete };
      waiting.add(entry);
      request.signal?.addEventListener(
        'abort',
        () => {
          waiting.delete(entry);
          reject(request.signal?.reason ?? new Error('Отменено'));
        },
        { once: true },
      );
    });
  },
});
const uiAddress = socketPath(directory);
const controlAddress = socketPath(directory + '-control');
const clients = new Set();
const counts = {};
const recent = [];
const uiFailures = new Map();
const droppedReplies = new Set();

function server(handle, tracked = false) {
  return createServer((socket) => {
    if (tracked) clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        void (async () => {
          let id;
          try {
            const request = JSON.parse(line);
            id = request.id;
            const result = await handle(request.method, request.params ?? {});
            if (tracked && droppedReplies.delete(request.method)) {
              socket.destroy();
              return;
            }
            socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
          } catch (error) {
            socket.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: {
                  code: -32000,
                  message: String(error?.message ?? error),
                  data: applicationErrorData(error) ?? resourceErrorData(error),
                },
              }) + '\n',
            );
          }
        })();
      }
    });
  });
}

const ui = server(async (method, params) => {
  counts[method] = (counts[method] ?? 0) + 1;
  recent.push({ method, params });
  if (recent.length > 100) recent.shift();
  if (uiFailures.has(method)) {
    const message = uiFailures.get(method);
    uiFailures.delete(method);
    throw new Error(message);
  }
  return dispatch(app, method, params);
}, true);

async function listen(instance, address) {
  await mkdir(dirname(address), { recursive: true, mode: 0o700 });
  await unlink(address).catch(() => {});
  await new Promise((done, fail) => {
    instance.once('error', fail);
    instance.listen(address, done);
  });
}

async function disconnect() {
  for (const client of clients) client.destroy();
  if (ui.listening) await new Promise((done) => ui.close(done));
}

async function pendingRequest(runId, agentId) {
  const run = app.sessions.get(runId);
  const title = run.agents[agentId ?? run.rootAgentId].task;
  const matches = (entry) =>
    entry.request.messages.some((message) => message.content.includes(title));
  const deadline = Date.now() + 5000;
  while (![...waiting].some(matches) && Date.now() < deadline) await delay(20);
  const entry = [...waiting].find(matches);
  if (!entry) throw new Error('Провайдер не получил задачу ' + title);
  return entry;
}

async function planRoles(runId, tasks) {
  const entry = await pendingRequest(runId);
  if (!entry.request.tools.some((tool) => tool.name === 'agents.plan'))
    throw new Error('Ожидался настоящий запрос планирования');
  waiting.delete(entry);
  entry.complete({
    text: '',
    calls: [
      {
        id: randomUUID(),
        name: 'agents.plan',
        arguments: JSON.stringify({
          mode: 'parallel',
          reason: 'Проверки независимы',
          tasks,
        }),
      },
    ],
    finish: 'tool_calls',
    usage: { input: 10, output: 5 },
  });
  const deadline = Date.now() + 5000;
  while (
    Object.keys(app.sessions.get(runId).agents).length < tasks.length + 1 &&
    Date.now() < deadline
  )
    await delay(20);
  return dispatch(app, 'runtime.status', { runId });
}

async function answerAgent(runId, agentId, text) {
  const entry = await pendingRequest(runId, agentId);
  waiting.delete(entry);
  entry.complete({ text, calls: [], finish: 'stop', usage: { input: 10, output: 5 } });
  const deadline = Date.now() + 5000;
  while (app.sessions.get(runId).agents[agentId].status === 'running' && Date.now() < deadline)
    await delay(20);
  return dispatch(app, 'runtime.status', { runId });
}

async function fileTool(runId, name, args) {
  if (!['fs.list', 'fs.search'].includes(name)) throw new Error('Неизвестная проверка файлов');
  const entry = await pendingRequest(runId);
  waiting.delete(entry);
  entry.complete({
    text: '',
    calls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
    finish: 'tool_calls',
    usage: { input: 10, output: 5 },
  });
  const next = await pendingRequest(runId);
  const result = next.request.messages.findLast((item) => item.role === 'tool');
  if (!result) throw new Error('Результат файловой проверки не попал в контекст');
  return JSON.parse(result.content);
}

async function complete(runId, operation, text) {
  const entry = await pendingRequest(runId);
  const run = app.sessions.get(runId);
  const title = run.agents[run.rootAgentId].task;
  const deadline = Date.now() + 5000;
  waiting.delete(entry);
  entry.complete({
    text: operation ? '' : (text ?? 'Готово: ' + title),
    calls: operation
      ? [
          {
            id: randomUUID(),
            name: operation === 'write' ? 'fs.write' : 'process.exec',
            arguments: JSON.stringify(
              operation === 'write'
                ? { path: 'Однократная запись.txt', content: 'Записано один раз.' }
                : {
                    command: process.execPath,
                    args:
                      operation === 'output'
                        ? [
                            '-e',
                            "process.stdout.write('x'.repeat(1048576)+'STDOUT_END'); process.stderr.write('y'.repeat(1048576)+'STDERR_END');",
                          ]
                        : ['--version'],
                  },
            ),
          },
        ]
      : [],
    finish: operation ? 'tool_calls' : 'stop',
    usage: { input: 10, output: 5 },
  });
  while (app.sessions.get(runId).status === 'running' && Date.now() < deadline) await delay(20);
  return { status: app.sessions.get(runId).status };
}

async function learning(params) {
  await app.learning.store.update((state) => {
    if (params.tokens !== undefined) {
      if (!Number.isSafeInteger(params.tokens) || params.tokens < 0)
        throw new Error('Некорректный проверочный расход обучения');
      state.daily = { date: new Date().toISOString().slice(0, 10), tokens: params.tokens };
    }
    if (params.lessons) {
      state.candidates = Object.fromEntries(
        params.lessons.map((lesson) => [
          lesson.id,
          {
            id: lesson.id,
            sourceRunId: params.runId ?? randomUUID(),
            workspace: app.config.value.workspaces[0],
            role: 'coordinator',
            profile: 'fixture',
            title: lesson.title,
            lesson: lesson.text ?? 'Рекомендация из проверочного набора.',
            appliesWhen: 'Только в проверочном проекте.',
            evidenceIds: [],
            status: 'published',
            fingerprint: lesson.id,
          },
        ]),
      );
    }
    if (params.version) {
      const previous = state.activeVersion;
      state.activeVersion = params.version;
      state.releases[params.version] = {
        id: params.version,
        parentId: previous,
        createdAt: new Date().toISOString(),
        candidateIds: Object.keys(state.candidates),
      };
    }
    if (params.jobs)
      state.jobs = params.jobs.map((job) => ({
        id: job.id ?? randomUUID(),
        runId: params.runId ?? randomUUID(),
        role: 'coordinator',
        status: job.status,
        candidateId: job.candidateId,
      }));
  });
  return { updated: true };
}

let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await disconnect();
    if (control.listening) await new Promise((done) => control.close(done));
    await app.close();
    await release();
    await unlink(controlAddress).catch(() => {});
  })();
  return closing;
}

const control = server(async (method, params) => {
  if (method === 'inventory') return seedScreenInventory(app, params);
  if (method === 'call') return dispatch(app, params.method, params.args ?? {});
  if (method === 'complete') return complete(params.runId);
  if (method === 'planRoles') return planRoles(params.runId, params.tasks);
  if (method === 'answerAgent') return answerAgent(params.runId, params.agentId, params.text);
  if (method === 'fileTool') return fileTool(params.runId, params.name, params.args);
  if (method === 'loseNextRunReply') {
    droppedReplies.add('runtime.run');
    return { scheduled: true };
  }
  if (method === 'answer') {
    if (typeof params.text !== 'string' || params.text.length > 64000)
      throw new Error('Некорректный проверочный ответ');
    return complete(params.runId, undefined, params.text);
  }
  if (method === 'modelMessages') {
    const entry = await pendingRequest(params.runId, params.agentId);
    return entry.request.messages.map(({ role, content }) => ({ role, content }));
  }
  if (method === 'approval') return complete(params.runId, 'approval');
  if (method === 'write') return complete(params.runId, 'write');
  if (method === 'commandOutput') return complete(params.runId, 'output');
  if (method === 'failNext') {
    if (params.method !== 'runtime.purge') throw new Error('Неизвестная проверочная ошибка');
    uiFailures.set(params.method, 'Проверочная ошибка записи: операция не выполнена.');
    return { scheduled: true };
  }
  if (method === 'learning') return learning(params);
  if (method === 'metrics') return { counts, recent };
  if (method === 'connection') {
    if (params.available) await listen(ui, uiAddress);
    else await disconnect();
    return { available: params.available };
  }
  if (method === 'close') {
    setTimeout(() => {
      void close().then(() => process.exit(0));
    }, 100);
    return { closing: true };
  }
  throw new Error('Неизвестная команда fixture: ' + method);
});
await listen(ui, uiAddress);
await listen(control, controlAddress);
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.stdout.write(JSON.stringify({ uiAddress, controlAddress }) + '\n');
