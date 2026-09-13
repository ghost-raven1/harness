import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { cleanup, eventually } from './helpers.js';
import { rpc } from '../src/interfaces/ipc.js';

export const cli = resolve('dist/interfaces/cli.js');
export interface ApiBody {
  messages: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string; description: string } }>;
}
export interface ApiAnswer {
  text?: string;
  calls?: Array<{ id: string; name: string; args: unknown }>;
  truncate?: boolean;
  status?: number;
}
/** Локальный HTTP API прогоняет настоящие SSE-потоки через библиотечный адаптер. */
export async function modelServer(
  answer: (body: ApiBody, request: IncomingMessage) => ApiAnswer | Promise<ApiAnswer>,
) {
  const bodies: ApiBody[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
        return;
      }
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body: ApiBody = JSON.parse(raw);
      bodies.push(body);
      const result = await answer(body, request);
      if (result.status) {
        response.writeHead(result.status);
        response.end('API failure');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = result.calls?.length
        ? {
            tool_calls: result.calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
        : { content: result.text ?? 'Готово' };
      const chunk = (delta: unknown, finish: string | null) => ({
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      response.write('data: ' + JSON.stringify(chunk(delta, null)) + '\n\n');
      if (!result.truncate)
        response.write(
          'data: ' +
            JSON.stringify(chunk({}, result.calls?.length ? 'tool_calls' : 'stop')) +
            '\n\ndata: [DONE]\n\n',
        );
      response.end();
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as { port: number }).port;
  return { baseUrl: 'http://127.0.0.1:' + port + '/v1', bodies };
}
export function alias(body: ApiBody, name: string): string {
  const tool = body.tools?.find((tool) => tool.function.description.startsWith(name + ':'));
  if (!tool) throw new Error('Expected advertised tool: ' + name);
  return tool.function.name;
}
export async function startDaemon(config: string | undefined, directory: string, cwd?: string) {
  const child = spawn(
    process.execPath,
    [cli, '--state', directory, '--json', 'serve', ...(config ? ['--config', config] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd },
  );
  let logs = '';
  child.stdout!.on('data', (data) => {
    logs += String(data);
  });
  child.stderr!.on('data', (data) => {
    logs += String(data);
  });
  const stopped = once(child, 'exit');
  cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await stopped;
  });
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error('Daemon failed: ' + logs);
    try {
      await rpc(directory, 'system.info');
      return true;
    } catch {
      return false;
    }
  }, 10000);
  return { child, stopped, logs: () => logs };
}
export async function command(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  options: { cwd?: string; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    cwd: options.cwd,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
  let stdout = '',
    stderr = '';
  child.stdout!.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr!.on('data', (data) => {
    stderr += String(data);
  });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}
