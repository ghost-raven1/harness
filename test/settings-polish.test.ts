import { beforeEach, expect, it, vi } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import * as prompts from '@clack/prompts';
import { settings } from '../src/interfaces/guided/settings.js';
import { changeProject } from '../src/interfaces/guided/projects.js';
import { previewPages, showFilePreview } from '../src/interfaces/guided/file-preview.js';
import { page, backFromPage } from '../src/interfaces/guided/screen.js';
import type { DesktopService, SessionKeys } from '../src/interfaces/guided/service.js';
import type { CliContext } from '../src/interfaces/types.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  note: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock('../src/interfaces/guided/screen.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/screen.js')>()),
  page: vi.fn(),
  backFromPage: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

const preferences = { configFile: '/config.json', workspace: '/workspace', profile: 'test' };
const keys = {} as SessionKeys;
function host(owner: boolean, active = 0): DesktopService {
  return { isOwner: owner, activeCount: () => active } as DesktopService;
}
function context(provider = 'openai-compatible'): CliContext {
  return {
    directory: () => '/state',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
    request: vi.fn(async () => ({ profiles: [{ id: 'test', provider }] })) as CliContext['request'],
  };
}

it('экран аккаунта Codex остаётся до возврата и не предлагает ненужный ключ', async () => {
  vi.mocked(prompts.select).mockResolvedValueOnce('key');
  let release!: () => void;
  vi.mocked(backFromPage).mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
  const client = context('codex');
  let returned = false;
  const running = settings(client, preferences, host(true), keys).then(() => (returned = true));
  await vi.waitFor(() => expect(backFromPage).toHaveBeenCalledOnce());
  expect(returned).toBe(false);
  expect(page).toHaveBeenLastCalledWith('Ключ API');
  expect(prompts.note).toHaveBeenCalledWith(
    expect.stringContaining('Ключ API не нужен'),
    'Аккаунт Codex',
  );
  expect(client.request).toHaveBeenNthCalledWith(1, 'system.info');
  expect(client.request).toHaveBeenNthCalledWith(2, 'system.info');
  expect(prompts.select).toHaveBeenCalledTimes(1);
  release();
  await running;
});

it.each([
  ['project', false, 0],
  ['project', true, 1],
  ['key', false, 0],
  ['key', true, 1],
] as const)(
  'объяснение недоступности %s не исчезает при owner=%s active=%s',
  async (action, owner, active) => {
    vi.mocked(prompts.select).mockResolvedValueOnce(action);
    const client = context();
    expect(await settings(client, preferences, host(owner, active), keys)).toBe(false);
    expect(backFromPage).toHaveBeenCalledOnce();
    expect(prompts.log.info).toHaveBeenCalledOnce();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.text).not.toHaveBeenCalled();
  },
);

it('объясняет, в каком окне переключить модель, и ждёт возврата', async () => {
  await changeProject('recent', preferences, host(false), keys);
  expect(page).toHaveBeenCalledWith('Недавние папки');
  expect(prompts.log.info).toHaveBeenCalledWith(expect.stringContaining('в другом окне'));
  expect(backFromPage).toHaveBeenCalledOnce();
  expect(prompts.select).not.toHaveBeenCalled();
});

it('узкий экран сохраняет строки diff и удаляет управляющие коды', () => {
  const lines = Array.from({ length: 27 }, (_, index) => '+ строка ' + index);
  const pages = previewPages('\u001b[2J' + lines.join('\n'), 48, 24);
  expect(pages).toHaveLength(4);
  expect(pages.every((part) => part.split('\n').length <= 7)).toBe(true);
  expect(pages.join('\n')).toBe(lines.join('\n'));
  const wrapped = previewPages('x'.repeat(130), 48, 24).join('\n');
  expect(wrapped.split('\n').every((line) => line.length <= 42)).toBe(true);
  expect(wrapped.replaceAll('\n', '')).toBe('x'.repeat(130));
});

it('весь diff показывается до возврата токена подтверждения', async () => {
  const load = vi.fn(async (offset: number) => ({
    path: 'файл.txt',
    diff: offset ? '+ конец' : '- начало',
    previewToken: 'immutable-token',
    next: offset ? undefined : 12000,
  }));
  vi.mocked(prompts.select).mockResolvedValueOnce('next');
  expect(await showFilePreview(load)).toBe('immutable-token');
  expect(load.mock.calls).toEqual([[0], [12000]]);
  expect(page).toHaveBeenCalledTimes(2);
  const [text, title] = vi.mocked(prompts.note).mock.calls.at(-1)!;
  expect(stripVTControlCharacters(text ?? '')).toBe('+ конец');
  expect(title).toBe('Изменения: файл.txt');
});

it('отмена просмотра не возвращает разрешение и не загружает следующую часть', async () => {
  const load = vi.fn(async () => ({
    path: 'file',
    diff: '+ text',
    previewToken: 'token',
    next: 12000,
  }));
  vi.mocked(prompts.select).mockResolvedValueOnce('stop');
  await expect(showFilePreview(load)).rejects.toThrow('INTERACTIVE_CANCEL');
  expect(load).toHaveBeenCalledOnce();
});

it('изменение файла между частями прерывает просмотр', async () => {
  const load = vi.fn(async (offset: number) => ({
    path: 'file',
    diff: '+ text',
    previewToken: offset ? 'new-token' : 'old-token',
    next: offset ? undefined : 12000,
  }));
  vi.mocked(prompts.select).mockResolvedValueOnce('next');
  await expect(showFilePreview(load)).rejects.toThrow('Файл изменился во время просмотра');
});
