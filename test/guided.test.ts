import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { mkdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listModels } from '../src/providers/catalog.js';
import { DesktopService, SessionKeys } from '../src/interfaces/guided/service.js';
import { readPreferences, savePreferences } from '../src/interfaces/guided/preferences.js';
import { onboarding } from '../src/interfaces/guided/onboarding.js';
import { chooseConnection } from '../src/interfaces/guided/connection.js';
import { diagnose } from '../src/interfaces/diagnostics.js';
import { settings } from '../src/interfaces/guided/settings.js';
import { followRun } from '../src/interfaces/guided/watch.js';
import { deleteTask } from '../src/interfaces/guided/delete-task.js';
import { newTask, saveAnswer } from '../src/interfaces/guided/tasks.js';
import { loadConfig } from '../src/configuration/loader.js';
import { commandClient, rpc } from '../src/interfaces/ipc.js';
import type { CliContext, StatusView } from '../src/interfaces/types.js';
import { configDirectory, cleanup, temporary } from './helpers.js';
import { modelServer, alias } from './process-fixture.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  password: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  note: vi.fn(),
  cancel: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));
beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function context(directory: string): CliContext {
  return {
    directory: () => directory,
    json: () => false,
    interactive: () => true,
    output: vi.fn(),
    request: commandClient(() => directory),
  };
}

it('мастер выбирает папку и модель из API, сохраняет конфиг с подтверждением записи', async () => {
  const root = await temporary(),
    workspace = join(root, 'Проект с пробелами');
  await mkdir(workspace);
  const api = await modelServer(() => ({ text: 'Не должен вызываться' }));
  vi.mocked(prompts.select)
    .mockResolvedValueOnce('use')
    .mockResolvedValueOnce('openai-compatible')
    .mockResolvedValueOnce('custom')
    .mockResolvedValueOnce('fixture-model');
  vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
  vi.mocked(prompts.text).mockResolvedValueOnce(api.baseUrl);
  const keys = new SessionKeys();
  const value = await onboarding(join(root, 'state'), keys, workspace);
  const config = await loadConfig(value.configFile);
  expect(value.workspace).toBe(workspace);
  expect(config.value.profiles[value.profile]!.model).toBe('fixture-model');
  expect(config.value.policy.rules).toContainEqual({ tool: 'fs.write', decision: 'ask', args: {} });
  expect(api.bodies).toHaveLength(0);
  await savePreferences(join(root, 'state'), value);
  expect(await readPreferences(join(root, 'state'))).toEqual(value);
  expect(await readFile(join(root, 'state', 'desktop.json'), 'utf8')).not.toContain('apiKey');
  if (process.platform !== 'win32')
    expect((await stat(join(root, 'state', 'desktop.json'))).mode & 0o777).toBe(0o600);
});

it('ключ не попадает в конфиг, восстанавливается исходное окружение после закрытия', async () => {
  const root = await temporary(),
    name = 'HARNESS_GUIDED_TEST_KEY';
  const original = process.env[name];
  const keys = new SessionKeys();
  try {
    process.env[name] = 'inherited-fixture';
    keys.set(name, 'session-fixture');
    keys.set(name, 'replacement-fixture');
    expect(process.env[name]).toBe('replacement-fixture');
    await savePreferences(root, {
      configFile: '/config',
      workspace: '/workspace',
      profile: 'test',
    });
    expect(await readFile(join(root, 'desktop.json'), 'utf8')).not.toMatch(/fixture/);
    keys.clear();
    expect(process.env[name]).toBe('inherited-fixture');
    delete process.env[name];
    keys.set(name, 'temporary-fixture');
    keys.clear();
    expect(process.env[name]).toBeUndefined();
  } finally {
    keys.clear();
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

it('подключение рабочего стола не закрывает сервис другого окна', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Ответ сервиса' }));
  const config = await configDirectory(root, api.baseUrl);
  const owner = new DesktopService(state),
    attached = new DesktopService(state);
  cleanup(() => owner.close());
  expect(await owner.connect()).toBeUndefined();
  await owner.start(config);
  expect(owner.isOwner).toBe(true);
  expect((await attached.connect())?.defaultProfile).toBe('test');
  await attached.close();
  expect(await owner.connect()).toBeDefined();
  await owner.close();
  expect(await attached.connect()).toBeUndefined();
});

it('диагностика проверяет конфиг сервиса, а её ошибка не превращает выход из меню в ошибку запуска', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const api = await modelServer(() => ({ text: 'Готово' }));
  const config = await configDirectory(root, api.baseUrl);
  const host = new DesktopService(state);
  cleanup(() => host.close());
  await host.start(config);
  expect((await diagnose(state)).config).toBe(config);
  await unlink(config);
  vi.mocked(prompts.select).mockResolvedValueOnce('doctor');
  const exitCode = process.exitCode;
  await settings(
    context(state),
    { configFile: config, workspace: join(root, 'workspace'), profile: 'test' },
    host,
    new SessionKeys(),
  );
  expect(process.exitCode).toBe(exitCode);
});

it('разрешение в том же окне связано с текущей задачей, затем можно продолжить сессию', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const api = await modelServer((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? { text: 'Проверено: готово' }
      : {
          calls: [
            {
              id: 'write-1',
              name: alias(body, 'fs.write'),
              args: { path: 'result.txt', content: 'проверено' },
            },
          ],
        },
  );
  const config = await configDirectory(root, api.baseUrl);
  const policyPath = join(root, 'config', 'policy.json');
  const policy = JSON.parse(await readFile(policyPath, 'utf8'));
  policy.rules.push({ tool: 'fs.write', decision: 'ask' });
  await writeFile(policyPath, JSON.stringify(policy));
  const owner = new DesktopService(state);
  cleanup(() => owner.close());
  await owner.start(config);
  const client = context(state),
    workspace = join(root, 'workspace');
  const run = await client.request('runtime.run', {
    message: 'Запиши результат',
    workspace,
    requestKey: randomUUID(),
  });
  vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
  const status = await followRun(client, run.runId);
  expect(status?.status).toBe('completed');
  expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('проверено');
  expect(status?.approvals).toHaveLength(0);
  vi.mocked(prompts.text).mockResolvedValueOnce('Что проверено?');
  vi.mocked(prompts.select).mockResolvedValueOnce('back');
  await newTask(client, { workspace, profile: 'test' }, status);
  const runs = await client.request('runtime.list');
  const next = await client.request('runtime.status', { runId: runs[0]!.runId });
  expect(next.sessionId).toBe(status?.sessionId);
  expect(next.runId).not.toBe(status?.runId);
});

it('Esc в вопросе разрешения оставляет задачу ожидающей; закрытие владельца отменяет её', async () => {
  const root = await temporary(),
    state = join(root, 'state');
  const api = await modelServer((body) => ({
    calls: [
      {
        id: 'exec-1',
        name: alias(body, 'process.exec'),
        args: { command: process.execPath, args: ['--version'] },
      },
    ],
  }));
  const config = await configDirectory(root, api.baseUrl);
  const owner = new DesktopService(state);
  cleanup(() => owner.close());
  await owner.start(config);
  const run = await rpc(state, 'runtime.run', {
    message: 'Проверь версию',
    workspace: join(root, 'workspace'),
    requestKey: randomUUID(),
  });
  vi.mocked(prompts.confirm).mockResolvedValueOnce(Symbol('cancel'));
  expect(await followRun(context(state), run.runId)).toBeUndefined();
  expect((await rpc(state, 'runtime.status', { runId: run.runId })).status).toBe(
    'awaiting_approval',
  );
  expect(owner.activeCount()).toBe(1);
  await owner.close();
  await owner.start(config);
  expect((await rpc(state, 'runtime.status', { runId: run.runId })).status).toBe('cancelled');
});

it('сохранение ответа не заменяет существующий пользовательский файл', async () => {
  const workspace = await temporary();
  const status = { workspace, runId: randomUUID(), result: 'Исходный ответ' };
  const path = await saveAnswer(status);
  await expect(saveAnswer({ ...status, result: 'Другой текст' })).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await readFile(path, 'utf8')).toBe('Исходный ответ\n');
});

it.each(['openai', 'anthropic', 'google'] as const)(
  'каталог %s использует его протокол авторизации и не запускает генерацию',
  async (provider) => {
    let called = false;
    const fetcher: typeof fetch = async (input, options) => {
      called = true;
      expect(String(input)).toContain('/models');
      expect(String(input)).not.toContain('secret-fixture');
      expect(options?.redirect).toBe('error');
      expect(options?.body).toBeUndefined();
      const headers = new Headers(options?.headers);
      expect(
        headers.get(
          provider === 'google'
            ? 'x-goog-api-key'
            : provider === 'anthropic'
              ? 'x-api-key'
              : 'Authorization',
        ),
      ).toBe(provider === 'openai' ? 'Bearer secret-fixture' : 'secret-fixture');
      return Response.json(
        provider === 'google'
          ? {
              models: [
                { name: 'models/gemini-fixture', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
              ],
            }
          : { data: [{ id: provider === 'openai' ? 'gpt-fixture' : 'claude-fixture' }] },
      );
    };
    const models = await listModels(
      { provider, baseUrl: 'https://example.test/v1' },
      'secret-fixture',
      fetcher,
    );
    expect(called).toBe(true);
    expect(models).toHaveLength(1);
  },
);

it('ошибка каталога не выводит секреты из ответа провайдера и ограничивает размер ответа', async () => {
  const profile = { provider: 'qwen' as const, baseUrl: 'https://example.test/v1' };
  await expect(
    listModels(profile, 'key', async () => new Response('secret-fixture', { status: 401 })),
  ).rejects.toThrow('Model API HTTP 401');
  await expect(
    listModels(profile, undefined, async () => new Response('x'.repeat(1024 * 1024 + 1))),
  ).rejects.toThrow('Список моделей слишком большой');
  await expect(listModels({ ...profile, baseUrl: 'http://remote.test/v1' })).rejects.toThrow(
    'https://',
  );
});

it('неверный ключ в мастере можно исправить до сохранения конфигурации', async () => {
  const keys = new SessionKeys();
  const name = 'HARNESS_MODEL_API_KEY',
    previous = process.env[name];
  delete process.env[name];
  try {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('secret-fixture', { status: 401 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'fixture-model' }] }));
    vi.mocked(prompts.select)
      .mockResolvedValueOnce('openai-compatible')
      .mockResolvedValueOnce('custom')
      .mockResolvedValueOnce('key')
      .mockResolvedValueOnce('fixture-model');
    vi.mocked(prompts.text).mockResolvedValueOnce('https://example.test/v1');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
    vi.mocked(prompts.password)
      .mockResolvedValueOnce('wrong-fixture')
      .mockResolvedValueOnce('correct-fixture');
    const profile = await chooseConnection(keys);
    expect(profile.model).toBe('fixture-model');
    expect(process.env[name]).toBe('correct-fixture');
    expect(prompts.note).toHaveBeenCalledWith(
      expect.stringContaining('не принял ключ'),
      'Список моделей недоступен',
    );
    expect(JSON.stringify(vi.mocked(prompts.note).mock.calls)).not.toContain('secret-fixture');
  } finally {
    keys.clear();
    if (previous !== undefined) process.env[name] = previous;
  }
});

it('повреждённые настройки предлагают явное восстановление вместо неявной замены', async () => {
  const root = await temporary();
  await expect(readPreferences(join(root, 'missing'))).resolves.toBeUndefined();
  await writeFile(join(root, 'desktop.json'), '{');
  await expect(readPreferences(root)).rejects.toThrow('Настроить заново');
});

it('мастер сохраняет разрешённую подпапку вместо подмены корнем проекта', async () => {
  const root = await temporary(),
    config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const workspace = join(root, 'workspace', 'Вложенный проект');
  await mkdir(workspace);
  // Конфиг обнаруживается в родительском каталоге, а workspace остаётся выбранной подпапкой.
  const { cp } = await import('node:fs/promises');
  await cp(join(root, 'config'), join(root, 'workspace', 'config'), { recursive: true });
  const manifest = JSON.parse(await readFile(config, 'utf8'));
  manifest.workspaces = ['..'];
  await writeFile(join(root, 'workspace', 'config', 'harness.json'), JSON.stringify(manifest));
  vi.mocked(prompts.select).mockResolvedValueOnce('use').mockResolvedValueOnce('project');
  const preferences = await onboarding(join(root, 'state'), new SessionKeys(), workspace);
  expect(preferences.workspace).toBe(workspace);
});

it('удаление из интерфейса по умолчанию отменено, после согласия сначала останавливает задачу', async () => {
  const client = context('/unused');
  const methods: string[] = [];
  client.request = (async (method: string) => {
    methods.push(method);
    return method === 'runtime.status' ? status : {};
  }) as CliContext['request'];
  client.json = () => true;
  const status = {
    runId: randomUUID(),
    task: 'Работающая задача',
    status: 'running',
  } as StatusView;
  vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
  expect(await deleteTask(client, status)).toBe(false);
  expect(methods).toEqual([]);
  expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
  expect(await deleteTask(client, status)).toBe(true);
  expect(methods).toEqual(['runtime.status', 'runtime.cancel', 'runtime.delete']);
  expect(prompts.log.success).not.toHaveBeenCalled();
});
