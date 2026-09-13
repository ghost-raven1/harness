import { assertRuntime } from '../../configuration/runtime-version.js';
import type { Profile } from '../../configuration/schema.js';
import { CredentialStore, connectionId } from './credentials.js';
import { rpc, serve } from '../ipc.js';
import type { ServiceInfo } from '../types.js';

/** Ключи живут в окружении текущего процесса до закрытия рабочего стола. */
export class SessionKeys {
  readonly credentials?: CredentialStore;
  private readonly scopes = new Map<string, string>();
  constructor(directory?: string) {
    if (directory) this.credentials = new CredentialStore(directory);
  }
  select(profile: Profile): void {
    const name = profile.apiKeyEnv;
    if (!name) return;
    const scope = connectionId(profile);
    if (this.scopes.has(name) && this.scopes.get(name) !== scope && this.previous.has(name)) {
      const original = this.previous.get(name);
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    this.scopes.set(name, scope);
  }
  private readonly previous = new Map<string, string | undefined>();

  set(name: string, value: string): void {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('Некорректное имя переменной ключа');
    if (!this.previous.has(name)) this.previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  /** Сохраняет выбор ключей в памяти, чтобы отмена настройки не меняла активное подключение. */
  checkpoint(): () => void {
    const previous = new Map(this.previous),
      scopes = new Map(this.scopes);
    const values = new Map([...this.previous.keys()].map((name) => [name, process.env[name]]));
    return () => {
      this.clear();
      for (const [name, value] of values) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      for (const [name, value] of previous) this.previous.set(name, value);
      this.scopes.clear();
      for (const [name, scope] of scopes) this.scopes.set(name, scope);
    };
  }

  clear(): void {
    for (const [name, value] of this.previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.previous.clear();
    this.scopes.clear();
  }
}

/** Подключается к существующему сервису либо владеет сервисом до закрытия окна. */
export class DesktopService {
  private owned?: Awaited<ReturnType<typeof serve>>;
  constructor(readonly directory: string) {}

  get isOwner(): boolean {
    return !!this.owned;
  }

  activeCount(): number {
    return (
      this.owned?.app.sessions
        .list()
        .filter((run) => ['running', 'awaiting_approval'].includes(run.status)).length ?? 0
    );
  }

  async connect(): Promise<ServiceInfo | undefined> {
    try {
      return await rpc<ServiceInfo>(this.directory, 'system.info');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Local service unavailable.'))
        return undefined;
      throw error;
    }
  }

  async start(configFile: string): Promise<ServiceInfo> {
    assertRuntime();
    this.owned = await serve(configFile, this.directory);
    return await rpc<ServiceInfo>(this.directory, 'system.info');
  }

  async close(): Promise<void> {
    await this.owned?.close();
    this.owned = undefined;
  }
}
