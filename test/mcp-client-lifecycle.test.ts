import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { McpClientService } from '../src/mcp-client/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { cleanup, fixtureConfig } from './helpers.js';

interface FixtureOptions {
  stalledPage?: 'first' | 'second';
  result?: Record<string, unknown>;
}

async function pagedServer(options: FixtureOptions = {}) {
  const pages: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const call = JSON.parse(raw) as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string; cursor?: string };
    };
    if (call.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const send = (result: unknown) => {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    };
    if (call.method === 'initialize') {
      send({
        protocolVersion: call.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'paged-tools', version: '1.0.0' },
      });
    } else if (call.method === 'tools/list') {
      const name = call.params?.cursor ? 'second' : 'first';
      pages.push(name);
      if (options.stalledPage === name) return;
      send({
        tools: [
          {
            name,
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: { count: { type: 'number' } },
              required: ['count'],
            },
          },
        ],
        ...(name === 'first' ? { nextCursor: 'page2' } : {}),
      });
    } else if (call.method === 'tools/call') {
      send(options.result ?? { content: [], structuredContent: { count: 3 } });
    } else {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const config = fixtureConfig(process.cwd());
  config.tools.mcp = [
    {
      id: 'remote',
      transport: 'http',
      url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      args: [],
      env: {},
      tools: { first: 'read', second: 'read' },
    },
  ];
  const service = new McpClientService();
  const registry = new ToolRegistry();
  cleanup(() => service.close());
  const context = {
    runId: 'test',
    workspace: process.cwd(),
    config,
    signal: new AbortController().signal,
  };
  return { config, service, registry, context, pages };
}

it.each(['first', 'second'] as const)(
  'MCP: зависшая страница %s прерывается по настроенному таймауту',
  async (stalledPage) => {
    const app = await pagedServer({ stalledPage });
    app.config.tools.timeoutMs = 200;
    const outcome = app.service.connect(app.config, app.registry).then(
      () => 'connected',
      (error: unknown) => error,
    );
    const failure = await Promise.race([outcome, delay(1500, 'still waiting')]);
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toHaveProperty('code', ErrorCode.RequestTimeout);
    expect(app.pages).toContain(stalledPage);
  },
);

it.each([
  { name: 'неверная структура', result: { content: [], structuredContent: { count: 'wrong' } } },
  { name: 'нет обязательной структуры', result: { content: [] } },
  {
    name: 'неверная структура при isError',
    result: { content: [], structuredContent: { count: 'wrong' }, isError: true },
  },
])('MCP: $name отклоняется на обеих страницах каталога', async ({ result }) => {
  const app = await pagedServer({ result });
  await app.service.connect(app.config, app.registry);
  for (const name of ['first', 'second']) {
    await expect(
      app.registry.get('mcp.remote.' + name).execute({}, app.context),
    ).rejects.toBeInstanceOf(McpError);
  }
});

it.each([
  { name: 'верная структура', result: { content: [], structuredContent: { count: 3 } } },
  { name: 'ошибка без структуры', result: { content: [], isError: true } },
  {
    name: 'ошибка с верной структурой',
    result: { content: [], structuredContent: { count: 3 }, isError: true },
  },
])('MCP: $name возвращается без изменений с каждой страницы', async ({ result }) => {
  const app = await pagedServer({ result });
  await app.service.connect(app.config, app.registry);
  for (const name of ['first', 'second']) {
    await expect(app.registry.get('mcp.remote.' + name).execute({}, app.context)).resolves.toEqual(
      result,
    );
  }
});
