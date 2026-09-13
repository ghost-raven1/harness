import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { rpc } from './ipc.js';
import { message } from '../shared/primitives.js';
import { resultCursorSchema } from './result-pages.js';

/** stdout принадлежит протоколу; подтверждения и управление опытом здесь не экспортируются. */
export function createMcpServer(directory: string): McpServer {
  const server = new McpServer({ name: 'modular-harness', version: '0.2.0' });
  const call = async (method: string, args: unknown) => {
    try {
      const result = await rpc<Record<string, unknown>>(directory, method, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const detail = message(error);
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: detail.startsWith('Local service unavailable.')
              ? 'Сервис Harness не запущен. Откройте «Запустить Harness», завершите выбор папки и модели и оставьте окно открытым. Затем повторите запрос.'
              : detail,
          },
        ],
      };
    }
  };
  server.registerTool(
    'harness.run',
    {
      description:
        'Начать задачу в harness. Вернуть runId и отслеживать harness.status до завершения.',
      inputSchema: {
        message: z.string().min(1).max(100000),
        workspace: z.string(),
        profile: z.string().optional(),
        sessionId: z.string().uuid().optional(),
        expectedParentRunId: z
          .string()
          .uuid()
          .optional()
          .describe('Последняя задача беседы, на ответ которой отвечает пользователь.'),
        requestKey: z.string().min(1).max(200),
      },
    },
    (args) => call('runtime.run', args),
  );
  server.registerTool(
    'harness.status',
    {
      description:
        'Получить состояние и новые события. Большой ответ передаётся через resultPage: пока hasMore=true, повторяйте с resultCursor=nextCursor. При ожидающем разрешении сообщить человеку о команде harness approvals.',
      inputSchema: {
        runId: z.string().uuid(),
        cursor: z.number().int().min(0).optional(),
        waitMs: z.number().int().min(0).max(25000).optional(),
        resultCursor: resultCursorSchema
          .optional()
          .describe('Курсор UTF-16 из resultPage.nextCursor для чтения следующей части ответа.'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => call('runtime.status', args),
  );
  server.registerTool(
    'harness.cancel',
    {
      description: 'Отменить задачу и её дочерние ветки.',
      inputSchema: { runId: z.string().uuid() },
    },
    (args) => call('runtime.cancel', args),
  );
  return server;
}
/** Подключает MCP-мост к stdio, оставляя stdout только для протокола. */
export async function runMcp(directory: string): Promise<void> {
  const server = createMcpServer(directory);
  await server.connect(new StdioServerTransport());
}
