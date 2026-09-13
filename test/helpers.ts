import { mkdtemp, mkdir, rm, cp, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach } from 'vitest';
import { configSchema, type Config, type ConfigSnapshot } from '../src/configuration/schema.js';
import { FileSessionStore } from '../src/sessions/store.js';
import { FileLearningStore } from '../src/learning/store.js';
import { PolicyService, FileApprovalService } from '../src/policy/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolScheduler } from '../src/tools/scheduler.js';
import { registerLocalTools } from '../src/tools/local.js';
import { InvocationExecutor } from '../src/runtime/executor.js';
import { HarnessRuntime } from '../src/runtime/engine.js';
import { ContextService } from '../src/context/service.js';
import { hash } from '../src/shared/primitives.js';
import type { ModelOutput, ModelProvider, ModelRequest, ToolCall } from '../src/providers/types.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export async function temporary(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'hr-')));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
export function cleanup(work: () => Promise<void>): void {
  cleanups.push(work);
}
export const output = (text: string, calls: ToolCall[] = []): ModelOutput => ({
  text,
  calls,
  finish: calls.length ? 'tools' : 'stop',
  usage: { input: 10, output: 5 },
});
export const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
export class ScriptedProvider implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(
    private readonly answer: (
      request: ModelRequest,
      index: number,
    ) => ModelOutput | Promise<ModelOutput>,
  ) {}
  async generate(request: ModelRequest): Promise<ModelOutput> {
    this.requests.push(structuredClone({ ...request, signal: undefined, onProgress: undefined }));
    return this.answer(request, this.requests.length - 1);
  }
}
export function fixtureConfig(workspace: string): Config {
  return configSchema.parse({
    schemaVersion: 1,
    basePrompt: 'Выполняй задачу. Запреты обязательны.',
    rules: ['Не выдумывай результат.'],
    workspaces: [workspace],
    defaultRole: 'coordinator',
    coordination: 'manual',
    defaultProfile: 'test',
    profiles: {
      test: {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'test',
        contextTokens: 32000,
        outputTokens: 1000,
        retries: 0,
      },
    },
    roles: {
      coordinator: { prompt: 'Координируй.', permissions: [{ tool: '*', decision: 'allow' }] },
      worker: { prompt: 'Выполняй подзадачу.', permissions: [{ tool: '*', decision: 'allow' }] },
      reader: {
        prompt: 'Только читай.',
        permissions: [
          { tool: 'fs.read', decision: 'allow' },
          { tool: 'agents.handoff', decision: 'allow' },
        ],
      },
    },
    policy: {
      default: 'deny',
      rules: [
        { tool: '*', decision: 'allow' },
        { tool: 'process.exec', decision: 'ask' },
      ],
    },
    tools: { timeoutMs: 2000 },
    limits: {},
    learning: { enabled: false, cases: [] },
  });
}
export async function harness(provider: ModelProvider, change?: (config: Config) => void) {
  const directory = await temporary(),
    workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const config = fixtureConfig(workspace);
  change?.(config);
  const snapshot: ConfigSnapshot = { value: config, hash: hash(config) };
  const sessions = new FileSessionStore(join(directory, 'state'));
  await sessions.initialize();
  const learning = new FileLearningStore(join(directory, 'state'));
  await learning.initialize();
  const policy = new PolicyService(),
    approvals = new FileApprovalService(sessions, policy);
  const registry = new ToolRegistry();
  registerLocalTools(registry, sessions);
  const scheduler = new ToolScheduler(config.limits.reads);
  const context = new ContextService(learning);
  const executor = new InvocationExecutor(sessions, registry, scheduler, policy, approvals);
  const runtime = new HarnessRuntime({
    configFile: '',
    initialConfig: snapshot,
    store: sessions,
    learning,
    provider,
    context,
    registry,
    policy,
    executor,
  });
  cleanups.push(() => runtime.close());
  return {
    directory,
    workspace,
    snapshot,
    sessions,
    learning,
    policy,
    approvals,
    registry,
    context,
    executor,
    runtime,
  };
}
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout = 5000,
): Promise<void> {
  const until = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('Timed out waiting for observable state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export async function configDirectory(root: string, baseUrl: string): Promise<string> {
  const directory = join(root, 'config');
  await cp(resolve('config'), directory, { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  const manifestPath = join(directory, 'harness.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.workspaces = ['../workspace'];
  manifest.defaultProfile = 'test';
  manifest.coordination = 'manual';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(directory, 'profiles.json'),
    JSON.stringify({
      test: {
        provider: 'qwen',
        baseUrl,
        model: 'test',
        contextTokens: 32768,
        outputTokens: 1000,
        retries: 0,
        timeoutMs: 5000,
      },
    }),
  );
  await writeFile(join(directory, 'learning.json'), JSON.stringify({ enabled: false, cases: [] }));
  return manifestPath;
}
