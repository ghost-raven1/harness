import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { Config } from '../configuration/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolOutcomeUnknownError } from '../tools/errors.js';
import { toolOutputValidator } from './output-validation.js';

/** В реестр попадают только внешние инструменты с явной классификацией. */
export class McpClientService {
  private readonly clients: Client[] = [];
  async connect(config: Config, registry: ToolRegistry): Promise<void> {
    try {
      for (const server of config.tools.mcp) {
        const jsonSchemaValidator = new AjvJsonSchemaValidator();
        const client = new Client(
          { name: 'modular-harness', version: '0.1.0' },
          { jsonSchemaValidator },
        );
        this.clients.push(client);
        const env: Record<string, string> = {};
        for (const [key, source] of Object.entries(server.env)) {
          const value = process.env[source];
          if (!value) throw new Error('Missing MCP environment variable: ' + source);
          env[key] = value;
        }
        if (server.tokenEnv && !process.env[server.tokenEnv])
          throw new Error('Missing MCP token: ' + server.tokenEnv);
        const transport =
          server.transport === 'stdio'
            ? new StdioClientTransport({
                command: server.command!,
                args: server.args,
                env: { PATH: process.env.PATH ?? '', ...env },
                stderr: 'inherit',
              })
            : new StreamableHTTPClientTransport(new URL(server.url!), {
                requestInit: {
                  headers: server.tokenEnv
                    ? { Authorization: 'Bearer ' + process.env[server.tokenEnv] }
                    : {},
                },
                reconnectionOptions: {
                  maxRetries: 0,
                  initialReconnectionDelay: 1000,
                  maxReconnectionDelay: 1000,
                  reconnectionDelayGrowFactor: 1,
                },
              });
        await client.connect(transport, { timeout: config.tools.timeoutMs });
        let cursor: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await client.listTools({ cursor }, { timeout: config.tools.timeoutMs });
          for (const tool of page.tools) {
            const effect = server.tools[tool.name];
            if (!effect) continue;
            const validateOutput = toolOutputValidator(tool, jsonSchemaValidator);
            registry.register({
              definition: {
                name: 'mcp.' + server.id + '.' + tool.name,
                description: tool.description ?? tool.name,
                schema: tool.inputSchema,
                effect,
              },
              async execute(args, context) {
                try {
                  const result = await client.callTool(
                    { name: tool.name, arguments: args },
                    undefined,
                    {
                      signal: context.signal,
                      timeout: context.config.tools.timeoutMs,
                    },
                  );
                  validateOutput?.(result);
                  return result;
                } catch (error) {
                  if (effect === 'write')
                    throw new ToolOutcomeUnknownError(
                      'MCP mutation lost its response; verify the external result',
                    );
                  throw error;
                }
              },
            });
          }
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor))
            throw new Error('MCP server repeated pagination cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.splice(0).map((client) => client.close()));
  }
}
