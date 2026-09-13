import { beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { z } from 'zod';
import { registerDashboard } from '../src/interfaces/commands/dashboard.js';
import { liveSelect, menuFrame } from '../src/interfaces/guided/live-select.js';
import { unlockProfile } from '../src/interfaces/guided/onboarding.js';
import { explainError } from '../src/interfaces/guided/errors.js';
import type { CliContext, ServiceInfo } from '../src/interfaces/types.js';

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  start: vi.fn(),
  close: vi.fn(),
  preferences: {
    configFile: '/fixture/config/harness.json',
    workspace: '/fixture/workspace',
    profile: 'test',
  },
}));
vi.mock('../src/interfaces/guided/service.js', () => ({
  DesktopService: class {
    connect = state.connect;
    start = state.start;
    close = state.close;
    isOwner = true;
    activeCount() {
      return 0;
    }
  },
  SessionKeys: class {
    clear() {}
  },
}));
vi.mock('../src/interfaces/guided/onboarding.js', () => ({
  onboarding: vi.fn(),
  unlockProfile: vi.fn(),
}));
vi.mock('../src/interfaces/guided/preferences.js', () => ({
  readPreferences: async () => state.preferences,
  savePreferences: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
vi.mock('../src/interfaces/guided/activity.js', () => ({
  activity: () => ({ start: vi.fn(), stop: vi.fn() }),
}));
vi.mock('../src/interfaces/guided/farewell.js', () => ({
  closeDesktop: async () => state.close(),
}));
beforeEach(() => vi.resetAllMocks());

const info: ServiceInfo = {
  node: '24',
  version: 'fixture',
  state: '/fixture/state',
  workspaces: ['/fixture/workspace'],
  defaultProfile: 'test',
  tools: [],
  profiles: [{ id: 'test', provider: 'qwen', model: 'fixture', configured: true, baseUrl: '' }],
};

it.each([48, 80])(
  'ошибка запуска имеет отдельный экран %s колонок и повтор использует прежний конфиг',
  async (width) => {
    state.connect.mockResolvedValue(undefined);
    state.start.mockResolvedValue(info);
    vi.mocked(unlockProfile)
      .mockRejectedValueOnce(new SyntaxError('Unexpected token private-json-body'))
      .mockResolvedValue(undefined);
    vi.mocked(liveSelect)
      .mockImplementationOnce(async (options) => {
        expect(options.title).toBe('Не удалось открыть Harness');
        const menu = await options.load();
        expect(menu.summary).toContain('В файле настроек ошибка JSON');
        expect(menu.summary).not.toContain('private-json-body');
        expect(menu.options.map((item) => item.value)).toEqual(['retry', 'reset', 'help', 'exit']);
        const frame = stripVTControlCharacters(menuFrame(options.title, menu, 'retry', width, 24));
        expect(frame).toContain('Harness by Ghost_Raven');
        expect(frame).toContain('Попробовать снова');
        expect(frame).toContain('Настроить заново');
        expect(frame).not.toMatch(/Unexpected|private-json-body/);
        expect(frame.split('\n').every((line) => stringWidth(line) <= width)).toBe(true);
        expect(frame.split('\n').length).toBeLessThan(24);
        return 'retry';
      })
      .mockResolvedValueOnce('exit');
    const context = {
      directory: () => '/fixture/state',
      interactive: () => true,
      json: () => false,
      output: vi.fn(),
      request: async () => info,
    } as CliContext;
    const program = new Command();
    registerDashboard(program, context);
    await program.parseAsync(['node', 'harness']);
    expect(unlockProfile).toHaveBeenCalledTimes(2);
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledWith(state.preferences.configFile);
  },
);

it('объяснение ошибок конфигурации не раскрывает JSON и не маскирует ошибки ответа модели', () => {
  const invalid = z.object({ profile: z.string() }).safeParse({ profile: { private: 'hidden' } });
  expect(invalid.success).toBe(false);
  if (!invalid.success)
    expect(explainError(invalid.error, 'configuration')).toContain('Структура настроек');
  const parse = new SyntaxError('Unexpected token secret-value, is not valid JSON');
  expect(explainError(parse, 'configuration')).not.toContain('secret-value');
  expect(explainError(parse)).toBe(parse.message);
  expect(explainError(new Error('HTTP 401'), 'configuration')).toContain('не принял ключ');
});
