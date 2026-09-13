import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { ProviderError } from '../errors.js';
import { codexProviderError } from '../rate-limits.js';
import type { JsonObject } from '../../shared/primitives.js';

/** Находит зафиксированный npm-пакет Codex для текущей ОС, не используя глобальную установку. */
export function codexExecutable(): string {
  const targets: Record<string, string> = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'linux-x64': 'x86_64-unknown-linux-musl',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const platform = process.platform + '-' + process.arch;
  const target = targets[platform];
  if (!target) throw new ProviderError('Codex не поддерживает эту платформу: ' + platform);
  try {
    const file = createRequire(import.meta.url).resolve(
      '@openai/codex-' + platform + '/package.json',
    );
    return join(
      dirname(file),
      'vendor',
      target,
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
  } catch {
    throw new ProviderError(
      'Компонент Codex не установлен. Перезапустите установку Harness с optional dependencies.',
    );
  }
}

// Эти ограничения действуют до создания потока: внешние MCP, skills и хуки не запускаются.
export const codexRestrictions: JsonObject = {
  'orchestrator.mcp.enabled': false,
  'orchestrator.skills.enabled': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apply_patch_freeform': false,
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.codex_hooks': false,
  'features.plugin_hooks': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.js_repl': false,
  'features.code_mode': false,
  'features.memories': false,
  'features.memory_tool': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.image_generation': false,
  'features.view_image': false,
  'features.skill_search': false,
  'features.skip_host_skill_discovery': true,
  'features.shell_snapshot': false,
  'features.remote_control': false,
  'features.unbounded_connection_retries': false,
  'skills.bundled.enabled': false,
  'skills.include_instructions': false,
  'tools.update_plan.enabled': false,
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  include_environment_context: false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  developer_instructions: '',
  notify: [],
};

/** Ограниченный JSONL RPC-клиент официального app-server; секреты и stderr не попадают в журнал. */
export class CodexConnection extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private counter = 0;
  private closed = false;
  private readonly exited: Promise<void>;
  private readonly cancel: () => void;

  constructor(
    private readonly signal: AbortSignal,
    command = codexExecutable(),
    args: string[] = [],
  ) {
    super();
    signal.throwIfAborted();
    const flags = Object.entries(codexRestrictions).flatMap(([key, value]) => [
      '-c',
      key + '=' + JSON.stringify(value),
    ]);
    this.child = spawn(command, [...args, 'app-server', ...flags], {
      stdio: 'pipe',
      windowsHide: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => {
        this.fail(new ProviderError('Соединение с Codex закрыто до завершения ответа.'));
        resolve();
      });
      this.child.once('error', () => {
        this.fail(new ProviderError('Не удалось запустить компонент Codex.'));
        resolve();
      });
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () =>
      this.fail(new ProviderError('Codex закрыл канал запросов.')),
    );
    let buffered = '',
      bytes = 0;
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        this.fail(new ProviderError('Ответ Codex превысил лимит размера.'));
        return;
      }
      buffered += decoder.write(chunk);
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const message = JSON.parse(line) as JsonObject;
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
          const response =
            message.method === undefined && typeof message.id === 'number'
              ? this.pending.get(message.id)
              : undefined;
          if (response) {
            this.pending.delete(message.id as number);
            if (message.error)
              response.reject(
                codexProviderError(
                  message.error,
                  'Codex отклонил запрос ' +
                    String((message.error as JsonObject).code ?? '') +
                    '. Проверьте вход и доступность модели.',
                ),
              );
            else response.resolve(message.result);
          } else this.emit('message', message);
        } catch {
          this.fail(new ProviderError('Codex вернул повреждённый протокол.'));
        }
      }
    });
    this.cancel = () => this.fail(new ProviderError('Запрос Codex отменён или истёк тайм-аут.'));
    signal.addEventListener('abort', this.cancel, { once: true });
  }

  /** Согласует возможности app-server и подтверждает готовность клиента Codex. */
  async initialize(): Promise<void> {
    await this.call('initialize', {
      clientInfo: { name: 'modular_harness', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  /** Отправляет RPC с уникальным идентификатором и ожидает связанный ответ. */
  call(method: string, params: JsonObject): Promise<unknown> {
    if (this.closed) return Promise.reject(new ProviderError('Соединение с Codex уже закрыто.'));
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  /** Отклоняет ожидающие RPC и завершает процесс при первой ошибке соединения. */
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.emit('failure', error);
    this.child.kill('SIGKILL');
  }

  /** Ожидает остановки процесса перед тем, как Harness сможет исполнять побочный эффект. */
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.cancel);
    this.fail(new ProviderError('Соединение с Codex завершено.'));
    await this.exited;
    this.removeAllListeners();
  }
}
