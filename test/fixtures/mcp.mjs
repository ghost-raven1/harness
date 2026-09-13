import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'test-tools', version: '1.0.0' });
server.registerTool('echo', { inputSchema: { value: z.string() } }, async ({ value }) => ({
  content: [{ type: 'text', text: value }],
}));
server.registerTool('hidden', { inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'Не разрешён конфигурацией' }],
}));
server.registerTool('lost', { inputSchema: {} }, async () => {
  process.exit(0);
});
await server.connect(new StdioServerTransport());
