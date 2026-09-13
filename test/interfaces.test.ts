import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readAccessToken } from '../src/interfaces/local-channel.js';
import { stopProcessTree } from '../src/tools/process.js';
import { rpc, socketPath } from '../src/interfaces/ipc.js';
import { temporary, configDirectory, cleanup, eventually } from './helpers.js';
import { modelServer, startDaemon, command, alias, cli } from './process-fixture.js';
import type { StatusView } from '../src/interfaces/ui.js';

describe('Настоящие процессы CLI + MCP + локальный сервис', () => {
  it('CLI исправляет файл через HTTP модель, MCP использует ту же сессию и экспортирует ровно три операции', async () => {
    const root = await temporary(),
      directory = join(root, 'state');
    const api = await modelServer((body) => {
      const tools = body.messages.filter((m) => m.role === 'tool');
      if (tools.length === 0)
        return {
          calls: [{ id: 'bad', name: alias(body, 'fs.write'), args: { path: 'result.txt' } }],
        };
      if (tools.length === 1)
        return {
          calls: [
            {
              id: 'fixed',
              name: alias(body, 'fs.write'),
              args: { path: 'result.txt', content: 'Исправлено через CLI' },
            },
          ],
        };
      return { text: 'Результат проверен' };
    });
    const config = await configDirectory(root, api.baseUrl);
    await startDaemon(config, directory);
    const result = await command([
      '--state',
      directory,
      '--json',
      'run',
      'Сделай файл',
      '--workspace',
      join(root, 'workspace'),
      '--key',
      'cli',
      '--detach',
    ]);
    expect(result.code).toBe(0);
    const ids = JSON.parse(result.stdout);
    await eventually(
      async () =>
        (await rpc<StatusView>(directory, 'runtime.status', { runId: ids.runId })).status ===
        'completed',
    );
    expect(await readFile(join(root, 'workspace', 'result.txt'), 'utf8')).toBe(
      'Исправлено через CLI',
    );
    const client = new Client({ name: 'playtest', version: '1.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, '--state', directory, 'mcp'],
      stderr: 'pipe',
    });
    await client.connect(transport);
    cleanup(() => client.close());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'harness.cancel',
      'harness.run',
      'harness.status',
    ]);
    const repeated = await client.callTool({
      name: 'harness.run',
      arguments: { message: 'Сделай файл', workspace: join(root, 'workspace'), requestKey: 'cli' },
    });
    expect(JSON.parse((repeated.content as Array<{ text: string }>)[0]!.text).runId).toBe(
      ids.runId,
    );
    const status = await client.callTool({
      name: 'harness.status',
      arguments: { runId: ids.runId },
    });
    expect(JSON.parse((status.content as Array<{ text: string }>)[0]!.text).learningVersion).toBe(
      'baseline',
    );
    const unauthorized = await client.callTool({ name: 'approvals.decide', arguments: {} });
    expect(unauthorized.isError).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(socketPath(directory))).mode & 0o777).toBe(0o600);
    }
    const second = await command(['--state', directory, '--json', 'serve', '--config', config]);
    expect(second.code).toBe(1);
    expect(second.stdout).toContain('already owns');
    const approvals = await command(['--state', directory, '--json', 'approvals']);
    expect(approvals.code).toBe(0);
    expect(JSON.parse(approvals.stdout)).toEqual([]);
  });
  it('SIGKILL после побочного эффекта → unknown → проверка человеком → resume без повторной команды', async () => {
    const root = await temporary(),
      directory = join(root, 'state');
    const api = await modelServer((body) =>
      body.messages.some((m) => m.role === 'tool')
        ? { text: 'Продолжено без повтора' }
        : {
            calls: [
              {
                id: 'mutation',
                name: alias(body, 'process.exec'),
                args: {
                  command: process.execPath,
                  args: [
                    '-e',
                    "require('fs').appendFileSync('counter','x'); require('fs').writeFileSync('pid',String(process.pid)); setTimeout(()=>{},60000)",
                  ],
                },
              },
            ],
          },
    );
    const config = await configDirectory(root, api.baseUrl);
    const daemon = await startDaemon(config, directory);
    const { runId } = await rpc<{ runId: string }>(directory, 'runtime.run', {
      message: 'Изменение с разрешением',
      workspace: join(root, 'workspace'),
      requestKey: 'crash',
    });
    await eventually(
      async () =>
        (await rpc<StatusView>(directory, 'runtime.status', { runId })).status ===
        'awaiting_approval',
    );
    const waiting = await rpc<StatusView>(directory, 'runtime.status', { runId });
    await rpc(directory, 'approvals.decide', { approvalId: waiting.approvals[0]!.id, allow: true });
    await eventually(async () => {
      try {
        return !!(await readFile(join(root, 'workspace', 'pid')));
      } catch {
        return false;
      }
    });
    daemon.child.kill('SIGKILL');
    await daemon.stopped;
    const pid = Number(await readFile(join(root, 'workspace', 'pid'), 'utf8'));
    // После SIGKILL сервиса процесс ОС может остаться жив; тест явно убирает созданную им группу.
    try {
      await stopProcessTree(pid);
    } catch {
      /* Группа уже завершилась. */
    }
    await startDaemon(config, directory);
    const recovered = await rpc<StatusView>(directory, 'runtime.status', { runId });
    expect(recovered.status).toBe('paused');
    expect(recovered.unknownInvocations).toHaveLength(1);
    await expect(rpc(directory, 'runtime.resume', { runId })).rejects.toThrow('Resolve unknown');
    await rpc(directory, 'runtime.resolve', {
      runId,
      invocationId: recovered.unknownInvocations[0]!.id,
      result: 'Проверено: counter содержит x',
      succeeded: true,
    });
    const resumed = await command(['--state', directory, '--json', 'resume', runId]);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('Продолжено без повтора');
    expect(await readFile(join(root, 'workspace', 'counter'), 'utf8')).toBe('x');
    expect(api.bodies).toHaveLength(2);
  });
  it('отмена завершается во время ask; в занятой сессии новый запуск запрещён', async () => {
    const root = await temporary(),
      directory = join(root, 'state');
    const api = await modelServer((body) => ({
      calls: [
        { id: 'ask', name: alias(body, 'process.exec'), args: { command: 'false', args: [] } },
      ],
    }));
    await startDaemon(await configDirectory(root, api.baseUrl), directory);
    const ids = await rpc<{ runId: string; sessionId: string }>(directory, 'runtime.run', {
      message: 'x',
      workspace: join(root, 'workspace'),
      requestKey: 'ask',
    });
    await eventually(
      async () =>
        (await rpc<StatusView>(directory, 'runtime.status', { runId: ids.runId })).status ===
        'awaiting_approval',
    );
    await expect(
      rpc(directory, 'runtime.run', {
        message: 'y',
        workspace: join(root, 'workspace'),
        sessionId: ids.sessionId,
        requestKey: 'busy',
      }),
    ).rejects.toThrow('Session already');
    expect((await command(['--state', directory, '--json', 'cancel', ids.runId])).code).toBe(0);
    const status = await rpc<StatusView>(directory, 'runtime.status', { runId: ids.runId });
    expect(status.status).toBe('cancelled');
    expect(status.agents.every((a) => a.status === 'cancelled')).toBe(true);
    expect(await rpc(directory, 'approvals.list')).toEqual([]);
  });
  it('разделённый UTF-8 пакет не портит русский текст', async () => {
    const root = await temporary(),
      directory = join(root, 'state');
    const api = await modelServer(() => ({ text: 'ok' }));
    await startDaemon(await configDirectory(root, api.baseUrl), directory);
    const packet = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fragment',
        token: await readAccessToken(directory),
        method: 'runtime.run',
        params: { message: 'Японский ёж', workspace: join(root, 'workspace'), requestKey: 'utf8' },
      }) + '\n',
    );
    const cut = packet.indexOf(Buffer.from('Я')) + 1;
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath(directory));
      socket.on('error', reject);
      socket.on('data', () => {
        socket.end();
        resolve();
      });
      socket.on('connect', () => {
        socket.write(packet.subarray(0, cut));
        setTimeout(() => socket.write(packet.subarray(cut)), 25);
      });
    });
    const list = await rpc<Array<{ task: string }>>(directory, 'runtime.list');
    expect(list[0]!.task).toBe('Японский ёж');
  });
});

it.skipIf(process.platform === 'win32')(
  'не оставляет блокировку при ошибке подготовки сокета',
  async () => {
    const { mkdir, rm } = await import('node:fs/promises');
    const { serve } = await import('../src/interfaces/ipc.js');
    const root = await temporary();
    const directory = join(root, 'state');
    const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
    await mkdir(socketPath(directory), { recursive: true });

    await expect(serve(config, directory)).rejects.toThrow();
    await expect(stat(join(directory, 'daemon.lock'))).rejects.toMatchObject({ code: 'ENOENT' });

    await rm(socketPath(directory), { recursive: true });
    const service = await serve(config, directory);
    cleanup(() => service.close());
    expect(await rpc(directory, 'runtime.list')).toEqual([]);
  },
);
