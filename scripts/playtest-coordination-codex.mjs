import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { initializeProject } from '../dist/configuration/initialize.js';
import { codexAccount } from '../dist/providers/codex/account.js';
import { serve } from '../dist/interfaces/ipc.js';

/** Реальный MCP и Codex работают только с двумя контрольными файлами во временной папке. */
const directory = await mkdtemp(join(tmpdir(), 'harness-team-codex-'));
const report = { checkedAt: new Date().toISOString(), node: process.version, passed: false };
let service, client;
try {
  const account = await codexAccount();
  if (!account.loggedIn) throw new Error('Нет входа в Codex.');
  const model = account.models.find((item) => item.isDefault)?.id;
  if (!model) throw new Error('Нет модели по умолчанию.');
  report.model = model;
  const workspace = join(directory, 'workspace'),
    state = join(directory, 'state');
  await mkdir(workspace);
  const tokens = [randomUUID(), randomUUID()];
  await writeFile(join(workspace, 'catalog.txt'), tokens[0]);
  await writeFile(join(workspace, 'billing.txt'), tokens[1]);
  const configFile = await initializeProject({
    directory: join(directory, 'config'),
    workspace,
    provider: 'codex',
    model,
    baseUrl: 'codex://account',
    confirmWrites: true,
  });
  const manifest = JSON.parse(await readFile(configFile, 'utf8'));
  manifest.defaultRole = 'lead';
  manifest.coordination = 'auto';
  manifest.limits.turns = 12;
  await writeFile(configFile, JSON.stringify(manifest));
  const configured = {
    lead: {
      prompt:
        'Координируй независимые проверки каталога и биллинга. Передай каждую её специалисту, собери оба результата. Сам не читай файлы. Итог содержит оба найденных маркера.',
    },
    catalog_reader: {
      prompt:
        'Специалист по каталогу. Читай catalog.txt через fs.read ровно один раз и верни его точное содержимое. Не делегируй.',
    },
    billing_reader: {
      prompt:
        'Специалист по биллингу. Читай billing.txt через fs.read ровно один раз и верни его точное содержимое. Не делегируй.',
    },
  };
  const roles = {};
  for (const [name, value] of Object.entries(configured)) {
    await writeFile(join(directory, 'config', 'prompts', name + '.md'), value.prompt);
    roles[name] = {
      prompt: 'prompts/' + name + '.md',
      permissions: [
        { tool: 'fs.read', decision: 'allow' },
        ...(name === 'lead' ? [{ tool: 'agents.*', decision: 'allow' }] : []),
      ],
    };
  }
  await writeFile(join(directory, 'config', 'roles.json'), JSON.stringify(roles));
  await writeFile(
    join(directory, 'config', 'learning.json'),
    JSON.stringify({ enabled: false, cases: [] }),
  );
  service = await serve(configFile, state);
  client = new Client({ name: 'harness-team-playtest', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/interfaces/cli.js'), '--state', state, 'mcp'],
      stderr: 'ignore',
    }),
  );
  const request = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error('MCP request failed: ' + name);
    return (
      result.structuredContent ??
      JSON.parse(result.content.find((item) => item.type === 'text').text)
    );
  };
  const started = await request('harness.run', {
    message:
      'Независимо проверь каталог и биллинг: в catalog.txt и billing.txt лежат их контрольные маркеры. Используй параллельные специализированные проверки, затем верни оба маркера.',
    workspace,
    requestKey: randomUUID(),
  });
  const until = Date.now() + 300000;
  let cursor = 0,
    status;
  do {
    status = await request('harness.status', { runId: started.runId, cursor, waitMs: 10000 });
    cursor = status.cursor;
    if (!['running', 'awaiting_approval'].includes(status.status)) break;
  } while (Date.now() < until);
  const run = service.app.sessions.get(started.runId);
  report.status = run.status;
  report.error = run.error;
  report.turns = run.turns;
  report.usage = run.usage;
  report.plan = run.coordination?.plan;
  report.roles = Object.values(run.agents).map((agent) => ({
    role: agent.role,
    status: agent.status,
  }));
  report.invocations = Object.values(run.invocations).map((item) => ({
    tool: item.call.name,
    status: item.status,
    role: item.role,
  }));
  const events = service.app.sessions.history(run.id, 0);
  report.modelBatches = events
    .filter((event) => event.type === 'model.completed')
    .map((event) => {
      const agent = event.state.agents[event.payload.agentId];
      const response = agent?.messages.at(-1);
      return {
        role: agent?.role,
        calls: (response?.toolCalls ?? []).map((call) => ({
          name: call.name,
          ...(call.name === 'fs.read' ? { arguments: JSON.parse(call.arguments) } : {}),
        })),
      };
    });
  report.simultaneousSpecialists = events.some(
    (event) =>
      Object.values(event.state.agents).filter(
        (agent) => agent.parentId && agent.status === 'running',
      ).length === 2,
  );
  report.answerVerified = tokens.every((token) => run.result?.includes(token));
  report.passed =
    run.status === 'completed' &&
    run.coordination?.plan?.mode === 'parallel' &&
    report.simultaneousSpecialists &&
    report.answerVerified &&
    report.roles.some((item) => item.role === 'catalog_reader') &&
    report.roles.some((item) => item.role === 'billing_reader');
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await client?.close();
  await service?.close();
  await rm(directory, { recursive: true, force: true });
  await writeFile('docs/playtest-coordination-codex.json', JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
