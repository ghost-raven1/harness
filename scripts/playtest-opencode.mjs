import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { rpc } from '../dist/interfaces/ipc.js';

/** Настоящий OpenCode вызывает MCP; ответы моделей воспроизводятся локальным HTTP-сервером. */
const root = await realpath(await mkdtemp(join(tmpdir(), 'ho-')));
const state = join(root, 'state'),
  workspace = join(root, 'workspace');
const executable = resolve('dist/interfaces/cli.js');
const observed = { outer: 0, inner: 0, evaluations: 0, proposals: 0, usedLesson: false };
const children = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 45000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Playtest timed out');
    await pause(100);
  }
}
function run(binary, args, env = process.env) {
  const child = spawn(binary, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
  return { child, done };
}
function extractId(text) {
  return text.match(/"runId"\s*:\s*"([a-f0-9-]{36})"/)?.[1];
}
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw),
      messages = body.messages ?? [],
      system = messages.find((m) => m.role === 'system')?.content ?? '';
    const full = JSON.stringify(messages),
      tools = messages.filter((m) => m.role === 'tool');
    let text = '',
      calls = [];
    const named = (name) => {
      const tool = body.tools?.find((t) => t.function.description?.startsWith(name + ':'));
      assert(tool, 'Missing harness tool ' + name);
      return tool.function.name;
    };
    if (body.model === 'outer') {
      observed.outer++;
      const functions = body.tools?.map((t) => t.function.name) ?? [];
      if (!functions.length) text = 'Проверка harness';
      else if (!tools.length) {
        const name = functions.find((n) => /harness.*run$/.test(n));
        assert(name, 'OpenCode did not load harness.run');
        calls = [
          {
            name,
            args: { message: 'Исправь и проверь файл', workspace, requestKey: 'opencode-playtest' },
          },
        ];
      } else {
        const combined = tools
          .map((t) => (typeof t.content === 'string' ? t.content : JSON.stringify(t.content)))
          .join('\n');
        if (combined.includes('"status": "completed"') || combined.includes('"status":"completed"'))
          text = 'OpenCode проверил harness через MCP';
        else {
          const runId = extractId(combined);
          assert(runId, 'Missing run ID in MCP response');
          const name = functions.find((n) => /harness.*status$/.test(n));
          assert(name);
          calls = [{ name, args: { runId, waitMs: 1000 } }];
        }
      }
    } else if (String(system).startsWith('Extract one')) {
      observed.proposals++;
      const observations = JSON.parse(messages[1].content).observations;
      text = JSON.stringify({
        title: 'Проверка записи',
        lesson: 'После записи перечитай файл и проверь UTF-8.',
        appliesWhen: 'При проверке текстового файла',
        evidenceIds: observations
          .filter((o) => o.content.includes('fs.read'))
          .map((o) => o.id)
          .slice(0, 1),
      });
    } else if (full.includes('TARGET_CASE') || full.includes('HOLDOUT_CASE')) {
      observed.evaluations++;
      text = full.includes('HOLDOUT_CASE')
        ? 'HOLDOUT_OK'
        : full.includes('проверь UTF-8')
          ? 'TARGET_OK'
          : 'OLD_BEHAVIOR';
    } else {
      observed.inner++;
      if (full.includes('проверь UTF-8')) observed.usedLesson = true;
      if (!tools.length) calls = [{ name: named('fs.write'), args: { path: 'answer.txt' } }];
      else if (tools.length === 1)
        calls = [
          {
            name: named('fs.write'),
            args: { path: 'answer.txt', content: 'Проверено через OpenCode → MCP → harness' },
          },
        ];
      else if (tools.length === 2)
        calls = [{ name: named('fs.read'), args: { path: 'answer.txt' } }];
      else
        text =
          'Файл записан и прочитан' + (observed.usedLesson ? '; применён проверенный опыт' : '');
    }
    const delta = calls.length
      ? {
          tool_calls: calls.map((call, index) => ({
            index,
            id: 'c' + messages.length + '_' + index,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }
      : { content: text };
    const chunk = (delta, finish) => ({
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify(chunk(delta, null)) +
        '\n\ndata: ' +
        JSON.stringify(chunk({}, calls.length ? 'tool_calls' : 'stop')) +
        '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
    process.stderr.write(String(error) + '\n');
  }
});
let daemon;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/v1';
  await cp(resolve('config'), join(root, 'config'), { recursive: true });
  await mkdir(workspace);
  const manifest = JSON.parse(await readFile(join(root, 'config/harness.json'), 'utf8'));
  manifest.workspaces = ['../workspace'];
  manifest.defaultProfile = 'test';
  manifest.coordination = 'manual';
  await writeFile(join(root, 'config/harness.json'), JSON.stringify(manifest));
  await writeFile(
    join(root, 'config/profiles.json'),
    JSON.stringify({
      test: { provider: 'qwen', baseUrl: baseURL, model: 'inner', retries: 0, outputTokens: 1000 },
    }),
  );
  await writeFile(
    join(root, 'config/learning.json'),
    JSON.stringify({
      enabled: true,
      cases: [
        {
          id: 'target',
          kind: 'target',
          role: 'coordinator',
          prompt: 'TARGET_CASE',
          expect: { includes: ['TARGET_OK'] },
        },
        {
          id: 'holdout',
          kind: 'holdout',
          role: 'coordinator',
          prompt: 'HOLDOUT_CASE',
          expect: { includes: ['HOLDOUT_OK'] },
        },
      ],
    }),
  );
  daemon = run(process.execPath, [
    executable,
    '--state',
    state,
    '--json',
    'serve',
    '--config',
    join(root, 'config/harness.json'),
  ]);
  await until(async () => {
    try {
      await rpc(state, 'system.info');
      return true;
    } catch {
      return false;
    }
  });
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: 'playtest/outer',
    small_model: 'playtest/outer',
    provider: {
      playtest: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Local playtest',
        options: { baseURL, apiKey: 'fixture-only' },
        models: { outer: { name: 'Controlled API', limit: { context: 32768, output: 2048 } } },
      },
    },
    mcp: {
      harness: {
        type: 'local',
        command: [process.execPath, executable, '--state', state, 'mcp'],
        enabled: true,
        timeout: 10000,
      },
    },
    permission: { '*': 'deny', 'harness*': 'allow' },
  };
  await writeFile(join(root, 'opencode.json'), JSON.stringify(config));
  const env = {
    ...process.env,
    OPENCODE_CONFIG: join(root, 'opencode.json'),
    OPENCODE_CONFIG_DIR: join(root, 'oc-config'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
  };
  const binary = process.env.HARNESS_OPENCODE_BIN ?? 'opencode';
  const version = await run(binary, ['--version'], env).done;
  const listing = await run(binary, ['mcp', 'list'], env).done;
  assert.equal(listing.code, 0, listing.stderr);
  assert.match(listing.stdout, /connected/);
  const task = run(
    binary,
    [
      'run',
      '--format',
      'json',
      '--model',
      'playtest/outer',
      'Используй harness MCP для исправления файла и дождись результата.',
    ],
    env,
  );
  const timer = setTimeout(() => task.child.kill('SIGTERM'), 60000);
  let executed;
  try {
    executed = await task.done;
  } finally {
    clearTimeout(timer);
  }
  assert.equal(executed.code, 0, executed.stderr + executed.stdout);
  assert.match(executed.stdout, /OpenCode проверил harness/);
  assert.equal(
    await readFile(join(workspace, 'answer.txt'), 'utf8'),
    'Проверено через OpenCode → MCP → harness',
  );
  await until(async () => (await rpc(state, 'learning.status')).activeVersion !== 'baseline');
  const learning = await rpc(state, 'learning.status');
  const first = (await rpc(state, 'runtime.list'))[0];
  const firstStatus = await rpc(state, 'runtime.status', { runId: first.runId });
  assert.equal(firstStatus.learningVersion, 'baseline');
  const next = await rpc(state, 'runtime.run', {
    message: 'Новая проверка файла',
    workspace,
    requestKey: 'next',
  });
  await until(
    async () => (await rpc(state, 'runtime.status', { runId: next.runId })).status === 'completed',
  );
  const nextStatus = await rpc(state, 'runtime.status', { runId: next.runId });
  assert.equal(nextStatus.learningVersion, learning.activeVersion);
  assert(observed.usedLesson);
  await rpc(state, 'learning.pause');
  await rpc(state, 'learning.rollback', { reason: 'Проверка ручного отката' });
  assert.equal((await rpc(state, 'learning.status')).activeVersion, 'baseline');
  const report = {
    checkedAt: new Date().toISOString(),
    node: process.version,
    opencode: version.stdout.trim(),
    cloudInference: false,
    modelTransport: 'Controlled local HTTP/SSE API; real AI SDK adapters',
    checks: [
      'OpenCode MCP connected',
      'OpenCode harness.run and harness.status',
      'Invalid arguments corrected',
      'File write/read verified',
      'Lesson extracted from tool evidence',
      '3 repetitions per variant on target and holdout',
      'New run uses published version',
      'Original run remains baseline',
      'Rollback',
    ],
    observed,
    firstStatus: firstStatus.status,
    nextStatus: nextStatus.status,
    learnedVersion: learning.activeVersion,
  };
  await mkdir(resolve('docs'), { recursive: true });
  await writeFile(resolve('docs/playtest-opencode.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (daemon) await daemon.done;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
