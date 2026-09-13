import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeProject } from '../dist/configuration/initialize.js';
import { codexAccount } from '../dist/providers/codex/account.js';
import { serve } from '../dist/interfaces/ipc.js';

/** Проверяет настоящий маршрут MCP → Harness → Codex → fs.read в отдельной временной папке. */
const report = { checkedAt: new Date().toISOString(), node: process.version, passed: false };
const directory = await mkdtemp(join(tmpdir(), 'harness-codex-playtest-'));
let service, client;
try {
  const account = await codexAccount();
  if (!account.loggedIn) throw new Error('Сначала войдите в Codex через мастер Harness.');
  const model = account.models.find((item) => item.isDefault)?.id;
  if (!model) throw new Error('Не найдена модель Codex по умолчанию.');
  report.model = model;
  const workspace = join(directory, 'workspace'),
    state = join(directory, 'state');
  await mkdir(workspace);
  const nonce = randomUUID();
  await writeFile(join(workspace, 'probe.txt'), nonce);
  const config = await initializeProject({
    directory: join(directory, 'config'),
    workspace,
    provider: 'codex',
    model,
    baseUrl: 'codex://account',
    confirmWrites: true,
  });
  const manifest = JSON.parse(await readFile(config, 'utf8'));
  manifest.coordination = 'manual';
  manifest.limits.turns = 4;
  await writeFile(config, JSON.stringify(manifest));
  await writeFile(
    join(directory, 'config', 'learning.json'),
    JSON.stringify({ enabled: false, cases: [] }),
  );
  service = await serve(config, state);
  client = new Client({ name: 'harness-codex-playtest', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/interfaces/cli.js'), '--state', state, 'mcp'],
      stderr: 'ignore',
    }),
  );
  report.tools = (await client.listTools()).tools.map((tool) => tool.name);
  const call = async (name, args) => {
    const value = await client.callTool({ name, arguments: args });
    if (value.isError) throw new Error('Ошибка MCP ' + name);
    return (
      value.structuredContent ?? JSON.parse(value.content.find((item) => item.type === 'text').text)
    );
  };
  const started = await call('harness.run', {
    message:
      'Проверка подключения. Обязательно вызови fs.read для probe.txt ровно один раз. Верни только содержимое файла. Не делегируй и не используй другие инструменты.',
    workspace,
    profile: 'codex',
    requestKey: randomUUID(),
  });
  let status,
    cursor = 0;
  const until = Date.now() + 150000;
  do {
    status = await call('harness.status', { runId: started.runId, cursor, waitMs: 10000 });
    cursor = status.cursor;
    if (!['running', 'awaiting_approval'].includes(status.status)) break;
  } while (Date.now() < until);
  report.status = status.status;
  report.turns = status.turns;
  report.usage = status.usage;
  report.learningVersion = status.learningVersion;
  const run = service.app.sessions.get(started.runId);
  report.invocations = Object.values(run.invocations).map((invocation) => ({
    tool: invocation.call.name,
    status: invocation.status,
  }));
  report.answerVerified = status.result?.trim() === nonce;
  const stream = [];
  let outputCursor = 0;
  while (true) {
    const page = await service.app.sessions.output.page(started.runId, outputCursor);
    stream.push(...page.events);
    outputCursor = page.cursor;
    if (!page.hasMore) break;
  }
  report.visibleOutput = {
    textEvents: stream.filter((event) => event.type === 'text').length,
    reasoningEvents: stream.filter((event) => event.type === 'reasoning').length,
    answerPersisted: stream
      .filter((event) => event.type === 'text')
      .map((event) => event.text)
      .join('')
      .includes(nonce),
  };
  report.passed =
    status.status === 'completed' &&
    status.result?.trim() === nonce &&
    report.visibleOutput.answerPersisted &&
    report.invocations.some((item) => item.tool === 'fs.read' && item.status === 'succeeded');
  if (!report.passed) {
    report.error = status.error ?? 'Не подтверждён результат чтения через Harness.';
    process.exitCode = 1;
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await client?.close();
  await service?.close();
  await rm(directory, { recursive: true, force: true });
  await writeFile('docs/playtest-codex.json', JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
