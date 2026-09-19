import { createServer, createConnection } from 'node:net';
import { open, readFile, unlink, chmod } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  socketPath,
  privateDirectory,
  createAccessToken,
  readAccessToken,
  checkAccessToken,
  removeAccessToken,
} from './local-channel.js';
export { socketPath } from './local-channel.js';
import { z } from 'zod';
import { protocolVersion } from '../shared/identity.js';
import {
  ApplicationError,
  applicationErrorData,
  applicationErrorFromData,
} from '../shared/application-error.js';
import {
  commandName,
  parseCommandInput,
  parseCommandResponse,
  type CommandName,
  type CommandResponse,
  type CommandRequest,
  type RequestArguments,
} from './contracts/index.js';
import { id, message } from '../shared/primitives.js';
import { createApplication, type Application } from './application.js';
import { dispatch } from './routes.js';
import { resourceErrorData, resourceErrorFromData } from '../shared/resource-errors.js';
import { sessionConflictData, sessionConflictFromData } from '../shared/session-conflict.js';
import { encodeFrame, IPC_REQUEST_BYTES, IPC_RESPONSE_BYTES } from './ipc-limits.js';

const envelope = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.string(),
    method: z.string(),
    params: z.unknown(),
    token: z.string().optional(),
    protocolVersion: z.number().int().optional(),
  })
  .strict();

const responseEnvelope = z.union([
  z
    .object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.unknown() })
    .strict()
    .refine((value) => Object.hasOwn(value, 'result')),
  z
    .object({
      jsonrpc: z.literal('2.0'),
      id: z.string(),
      error: z.object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      }),
    })
    .strict(),
]);

/** Захватывает каталог состояния до восстановления журналов: второй процесс не трогает активные запуски. */
export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  await privateDirectory(directory);
  const path = join(directory, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.sync();
      await file.close();
      return async () => {
        await removeAccessToken(directory);
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error('Invalid daemon.lock; inspect it before removing');
      try {
        process.kill(pid, 0);
        throw new Error('Harness service already owns this state directory');
      } catch (problem) {
        if ((problem as NodeJS.ErrnoException).code !== 'ESRCH') throw problem;
        await unlink(path);
      }
    }
  }
  throw new Error('Could not acquire daemon lock');
}
/** Захватывает каталог состояния и открывает локальный JSON-RPC после восстановления приложения. */
export async function serve(
  configFile: string,
  directory: string,
): Promise<{ app: Application; close(): Promise<void> }> {
  const address = socketPath(directory);
  const release = await acquireLock(directory);
  let app: Application;
  let token: string | undefined;
  try {
    if (process.platform !== 'win32') {
      await privateDirectory(dirname(address));
      await unlink(address).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    token = await createAccessToken(directory);
    app = await createApplication(configFile, directory);
  } catch (error) {
    await release();
    throw error;
  }
  const sockets = new Set<import('node:net').Socket>();
  const requests = new Set<Promise<void>>();
  let stopping = false;
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (stopping) return void socket.destroy();
    socket.setEncoding('utf8');
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (data) => {
      if (stopping) return;
      buffer += data;
      if (Buffer.byteLength(buffer) > IPC_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const pending = (async () => {
          let requestId: string | null = null;
          try {
            const request = envelope.parse(JSON.parse(line));
            requestId = request.id;
            checkAccessToken(token, request.token);
            assertProtocolVersion(request.protocolVersion);
            const method = commandName(request.method);
            const params = parseCommandInput(method, request.params);
            const result = parseCommandResponse(method, await dispatch(app, method, params));
            if (!socket.destroyed)
              socket.write(
                encodeFrame(
                  { jsonrpc: '2.0', id: request.id, result },
                  IPC_RESPONSE_BYTES,
                  'response',
                ),
              );
          } catch (error) {
            if (!socket.destroyed)
              socket.write(
                encodeFrame(
                  {
                    jsonrpc: '2.0',
                    id: requestId,
                    error: {
                      code: -32000,
                      message: message(error).slice(0, 4096),
                      data:
                        applicationErrorData(error) ??
                        resourceErrorData(error) ??
                        sessionConflictData(error),
                    },
                  },
                  IPC_RESPONSE_BYTES,
                  'response',
                ),
              );
          }
        })();
        requests.add(pending);
        void pending.finally(() => requests.delete(pending)).catch(() => undefined);
      }
    });
    socket.on('error', () => undefined);
  });
  /** Закрывает вход, останавливает исполнителей и дожидается всех уже принятых команд. */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      stopping = true;
      for (const socket of sockets) socket.destroy();
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Отмена начинается до ожидания RPC: команда сама может ждать завершения задачи.
      await Promise.allSettled([app.runtime.close(), serverClosed, ...requests]);
      try {
        await app.close();
      } finally {
        await release();
      }
    })());
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, resolve);
    });
    if (process.platform !== 'win32') await chmod(address, 0o600);
    app.learning.start();
  } catch (error) {
    await close();
    throw error;
  }
  return { app, close };
}
/** Старый клиент без номера использует протокол 1; несовместимый запрос не меняет состояние. */
export function assertProtocolVersion(version: number | undefined): void {
  if (version !== undefined && version !== protocolVersion)
    throw new ApplicationError(
      'INCOMPATIBLE_PROTOCOL',
      'Версия протокола клиента несовместима с сервисом Harness.',
    );
}

/** Тип команды определяет параметры и ответ; клиент дополнительно проверяет ответ сервиса. */
export async function rpc<M extends CommandName>(
  directory: string,
  method: M,
  ...args: RequestArguments<M>
): Promise<CommandResponse<M>> {
  const params = parseCommandInput(method, args[0]);
  return parseCommandResponse(method, await rpcRaw(directory, method, params));
}

/** Связывает каталог с типизированным клиентом для CLI и других локальных интерфейсов. */
export function commandClient(directory: () => string): CommandRequest {
  return (async (method: CommandName, params?: unknown) => {
    const value = parseCommandInput(method, params);
    return parseCommandResponse(method, await rpcRaw(directory(), method, value));
  }) as CommandRequest;
}

/** Конверт без номера означает протокол 1 и остаётся понятным работающему сервису 0.2.x. */
export async function rpcRaw<T = unknown>(
  directory: string,
  method: string,
  params: unknown = {},
  requestedVersion: number | null = null,
): Promise<T> {
  let token: string | undefined;
  try {
    token = await readAccessToken(directory);
  } catch {
    throw new Error('Local service unavailable. Run harness serve first.');
  }
  const requestId = id();
  const frame = encodeFrame(
    {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
      token,
      protocolVersion: requestedVersion ?? undefined,
    },
    IPC_REQUEST_BYTES,
    'request',
  );
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(directory));
    socket.setEncoding('utf8');
    let buffer = '';
    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(new Error('Local service request timed out'));
      },
      ['diagnostics.verifyHistory', 'diagnostics.rebuildIndex'].includes(method) ? 600000 : 40000,
    );
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new Error('Local service closed the connection before completion'));
    });
    socket.on('connect', () => socket.write(frame));
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error('Local service unavailable. Run harness serve first. ' + error.message));
    });
    socket.on('data', (data) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > IPC_RESPONSE_BYTES) {
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('IPC response too large'));
        return;
      }
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = responseEnvelope.safeParse(JSON.parse(buffer.slice(0, at)));
        if (!parsed.success)
          throw new ApplicationError('INVALID_RESPONSE', 'Некорректный конверт ответа IPC.', {
            cause: parsed.error,
          });
        const response = parsed.data;
        if (response.id !== requestId)
          throw new ApplicationError('INVALID_RESPONSE', 'IPC response ID mismatch');
        if ('error' in response)
          throw (
            applicationErrorFromData(response.error.data, response.error.message) ??
            resourceErrorFromData(response.error.data) ??
            sessionConflictFromData(response.error.data) ??
            new Error(response.error.message)
          );
        resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}
