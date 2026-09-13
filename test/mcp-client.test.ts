import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpClientService } from '../src/mcp-client/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { fixtureConfig, cleanup } from './helpers.js';

it('MCP stdio: доверенная классификация, allowlist и неизвестный результат потерянной мутации', async () => {
  const config = fixtureConfig(process.cwd());
  config.tools.mcp = [
    {
      id: 'local',
      transport: 'stdio',
      command: process.execPath,
      args: [resolve('test/fixtures/mcp.mjs')],
      env: {},
      tools: { echo: 'read', lost: 'write' },
    },
  ];
  const registry = new ToolRegistry(),
    service = new McpClientService();
  cleanup(() => service.close());
  await service.connect(config, registry);
  expect(registry.definitions().map((t) => t.name)).toEqual(['mcp.local.echo', 'mcp.local.lost']);
  const context = {
    runId: 'test',
    workspace: process.cwd(),
    config,
    signal: new AbortController().signal,
  };
  const result = await registry.get('mcp.local.echo').execute({ value: 'Привет из MCP' }, context);
  expect(JSON.stringify(result)).toContain('Привет из MCP');
  await expect(registry.get('mcp.local.lost').execute({}, context)).rejects.toThrow(
    'verify the external result',
  );
});
it('MCP Streamable HTTP: handshake, авторизация и результат нативного транспорта', async () => {
  const auth: string[] = [];
  const server = createServer(async (request, response) => {
    auth.push(request.headers.authorization ?? '');
    const mcp = new McpServer({ name: 'http-tools', version: '1.0.0' });
    mcp.registerTool('echo', { inputSchema: { value: z.string() } }, async ({ value }) => ({
      content: [{ type: 'text', text: value }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  process.env.HARNESS_TEST_MCP_TOKEN = 'fixture-token';
  cleanup(async () => {
    delete process.env.HARNESS_TEST_MCP_TOKEN;
  });
  const config = fixtureConfig(process.cwd());
  config.tools.mcp = [
    {
      id: 'remote',
      transport: 'http',
      url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
      tokenEnv: 'HARNESS_TEST_MCP_TOKEN',
      args: [],
      env: {},
      tools: { echo: 'read' },
    },
  ];
  const registry = new ToolRegistry(),
    service = new McpClientService();
  cleanup(() => service.close());
  await service.connect(config, registry);
  const result = await registry
    .get('mcp.remote.echo')
    .execute(
      { value: 'HTTP работает' },
      { runId: 'test', config, workspace: process.cwd(), signal: new AbortController().signal },
    );
  expect(JSON.stringify(result)).toContain('HTTP работает');
  expect(auth.every((header) => header === 'Bearer fixture-token')).toBe(true);
});
