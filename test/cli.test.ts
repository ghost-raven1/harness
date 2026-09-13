import { it, expect, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { note } from '../src/interfaces/ui.js';
import { renderLogo } from '../src/interfaces/branding.js';
import { closeDesktop, renderFarewell } from '../src/interfaces/guided/farewell.js';
import { DesktopService } from '../src/interfaces/guided/service.js';
import { command } from './process-fixture.js';

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  select: vi.fn(),
}));

// Здесь проверяется жизненный цикл рабочего стола; клавиатура живого меню проверяется в PTY.
vi.mock('../src/interfaces/guided/live-select.js', () => ({
  liveSelect: () => prompts.select({ message: 'Чем займёмся?', options: [] }),
}));

it.each([8, 20, 40, 80])('логотип помещается в терминал шириной %s колонок', (columns) => {
  const logo = stripVTControlCharacters(renderLogo(columns));
  expect(logo).toContain('H');
  if (columns >= 11) expect(logo.replaceAll(' ', '').toUpperCase()).toContain('HARNESS');
  expect(logo.split('\n').every((line) => [...line].length <= columns)).toBe(true);
});

it('для простого терминала есть логотип без псевдографики', () => {
  const logo = stripVTControlCharacters(renderLogo(80, true));
  expect(logo).toContain('Harness by Ghost_Raven');
  expect(logo).toMatch(/^[\x20-\x7e]+$/);
});

it.each([20, 48, 90])('прощание помещается в %s колонок и сохраняет имя автора', (columns) => {
  const text = stripVTControlCharacters(renderFarewell('owned', columns));
  expect(text).toContain('Ghost_Raven');
  expect(text.replaceAll('\n', ' ')).toContain('История сохранена.');
  expect(text.split('\n').every((line) => [...line].length <= columns)).toBe(true);
  expect(stripVTControlCharacters(renderFarewell('owned', columns, true))).not.toContain('─');
});

it('отключение от чужого сервиса и отмена настройки не обещают остановку задач', () => {
  const attached = stripVTControlCharacters(renderFarewell('attached', 90));
  expect(attached).toContain('Сервис продолжает работать');
  expect(attached).not.toContain('История сохранена');
  const unstarted = stripVTControlCharacters(renderFarewell('unstarted', 90));
  expect(unstarted).toContain('Настройка отложена');
  expect(unstarted).not.toContain('История сохранена');
});

it('закрытие второго окна освобождает поток клавиатуры, который прежде не читался', async () => {
  const previous = process.stdin.isTTY;
  const raw = process.stdin.setRawMode;
  const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    process.stdin.isTTY = true;
    process.stdin.setRawMode = vi.fn(() => process.stdin);
    await closeDesktop({ close: async () => undefined }, { clear: vi.fn() }, vi.fn(), 'attached');
    expect(process.stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(pause).toHaveBeenCalledOnce();
  } finally {
    process.stdin.isTTY = previous;
    process.stdin.setRawMode = raw;
    pause.mockRestore();
    write.mockRestore();
  }
});

it('прощание появляется только после закрытия сервиса и возврата основного буфера', async () => {
  const previous = process.stdout.isTTY;
  const operations: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    operations.push(String(value));
    return true;
  });
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => (finish = resolve));
  const host = {
    close: async () => {
      await stopped;
      operations.push('closed');
    },
  };
  try {
    process.stdout.isTTY = true;
    const closing = closeDesktop(
      host,
      { clear: () => operations.push('keys-cleared') },
      () => operations.push('main-buffer'),
      'owned',
    );
    expect(operations).toEqual([]);
    finish();
    await closing;
    expect(operations.slice(0, 3)).toEqual(['closed', 'keys-cleared', 'main-buffer']);
    expect(stripVTControlCharacters(operations[3]!)).toContain('История сохранена.');
    expect(operations).toHaveLength(4);
  } finally {
    process.stdout.isTTY = previous;
    write.mockRestore();
  }
});

it('ошибка закрытия возвращает терминал, очищает ключи и не обещает сохранение', async () => {
  const previous = process.stdout.isTTY;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const clear = vi.fn(),
    leave = vi.fn();
  const failure = new Error('Не удалось записать журнал');
  try {
    process.stdout.isTTY = true;
    await expect(
      closeDesktop(
        {
          close: async () => {
            throw failure;
          },
        },
        { clear },
        leave,
        'owned',
      ),
    ).rejects.toBe(failure);
    expect(clear).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledOnce();
    const output = stripVTControlCharacters(
      write.mock.calls.map(([value]) => String(value)).join(''),
    );
    expect(output).toContain('Не удалось завершить работу');
    expect(output).not.toContain('История сохранена');
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!);
  } finally {
    process.stdout.isTTY = previous;
    write.mockRestore();
  }
});

it('закрытие рабочего стола не добавляет оформление в перенаправленный поток', async () => {
  const previous = process.stdout.isTTY;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    process.stdout.isTTY = false;
    await closeDesktop(
      { close: async () => undefined },
      { clear: () => undefined },
      () => undefined,
      'owned',
    );
    expect(write).not.toHaveBeenCalled();
  } finally {
    process.stdout.isTTY = previous;
    write.mockRestore();
  }
});

it('рабочий стол показывает логотип внутри экрана, а прощание после его закрытия', async () => {
  const { createCli } = await import('../src/interfaces/cli.js');
  const stdinTTY = process.stdin.isTTY,
    stdoutTTY = process.stdout.isTTY,
    term = process.env.TERM;
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const select = vi.mocked(prompts.select).mockResolvedValue('exit');
  const connect = vi.spyOn(DesktopService.prototype, 'connect').mockResolvedValue({
    node: process.version,
    version: 'test',
    state: '/unused',
    workspaces: ['/workspace'],
    defaultProfile: 'test',
    tools: [],
    profiles: [
      { id: 'test', model: 'fixture', provider: 'fixture', baseUrl: '', configured: true },
    ],
  });
  try {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    process.env.TERM = 'xterm';
    await createCli().parseAsync(['--state', join(tmpdir(), 'harness-no-desktop-preferences')], {
      from: 'user',
    });
    const output = write.mock.calls.map(([value]) => String(value)).join('');
    const enter = output.indexOf('\u001b[?1049h'),
      leave = output.indexOf('\u001b[?1049l');
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(leave).toBeGreaterThan(enter);
    expect(output.slice(0, enter)).not.toContain('Harness');
    expect(output.slice(enter, leave)).toContain('Harness');
    expect(stripVTControlCharacters(output.slice(leave))).toContain('Сервис продолжает работать');
    expect(output.slice(leave)).toContain('Ghost_Raven');
  } finally {
    process.stdin.isTTY = stdinTTY;
    process.stdout.isTTY = stdoutTTY;
    if (term === undefined) delete process.env.TERM;
    else process.env.TERM = term;
    connect.mockRestore();
    select.mockReset();
    write.mockRestore();
  }
});

it.each(['SIGTERM', 'SIGINT'] as const)(
  '%s остаётся под контролем рабочего стола до завершения асинхронного закрытия',
  async (signal) => {
    const { createCli } = await import('../src/interfaces/cli.js');
    const stdinTTY = process.stdin.isTTY,
      stdoutTTY = process.stdout.isTTY;
    const original = process.rawListeners(signal);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const connect = vi.spyOn(DesktopService.prototype, 'connect').mockResolvedValue({
      node: process.version,
      version: 'test',
      state: '/unused',
      workspaces: ['/workspace'],
      defaultProfile: 'test',
      tools: [],
      profiles: [
        { id: 'test', model: 'fixture', provider: 'fixture', baseUrl: '', configured: true },
      ],
    });
    let finish!: () => void, ready!: () => void;
    const stopped = new Promise<void>((resolve) => (finish = resolve));
    const selected = new Promise<void>((resolve) => (ready = resolve));
    const close = vi.spyOn(DesktopService.prototype, 'close').mockReturnValue(stopped);
    let handler: (typeof original)[number] | undefined;
    let running: Promise<unknown> | undefined;
    vi.mocked(prompts.select).mockImplementation(async () => {
      handler = process.rawListeners(signal).find((listener) => !original.includes(listener));
      ready();
      return 'exit';
    });
    try {
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;
      running = createCli().parseAsync(
        ['--state', join(tmpdir(), 'harness-no-desktop-preferences')],
        { from: 'user' },
      );
      await selected;
      expect(handler).toBeDefined();
      // Вызываем собственный raw-обработчик: настоящий сигнал не затрагивает процесс Vitest.
      handler!.call(process);
      expect(process.rawListeners(signal)).toContain(handler);
      handler!.call(process);
      expect(close).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      finish();
      await running;
      expect(exit).toHaveBeenCalledExactlyOnceWith(130);
      expect(process.rawListeners(signal)).toEqual(original);
    } finally {
      finish();
      await running?.catch(() => undefined);
      process.stdin.isTTY = stdinTTY;
      process.stdout.isTTY = stdoutTTY;
      connect.mockRestore();
      close.mockRestore();
      vi.mocked(prompts.select).mockReset();
      exit.mockRestore();
      write.mockRestore();
    }
  },
);

it('справка в перенаправленном выводе не содержит логотипа и ANSI-команд', async () => {
  const result = await command(['--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('learning');
  expect(result.stdout).not.toContain('[H]');
  expect(result.stdout).not.toContain('╭');
  expect(stripVTControlCharacters(result.stdout)).toBe(result.stdout);
});

it('ошибка JSON-команды остаётся чистым JSON после подключения логотипа', async () => {
  const result = await command([
    '--state',
    join(tmpdir(), 'harness-no-such-service'),
    '--json',
    'status',
  ]);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain('Local service unavailable');
  expect(stripVTControlCharacters(result.stdout)).toBe(result.stdout);
});

it.each([20, 40, 80])(
  'карточка разрешения помещается в %s колонок без потери аргументов',
  (columns) => {
    const previous = process.stdout.columns;
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const longPath = '/workspace/' + 'длинный-путь/'.repeat(12) + 'node';
    try {
      process.stdout.columns = columns;
      note(JSON.stringify({ command: longPath }), 'process.exec · точные аргументы');
      const printed = stripVTControlCharacters(
        write.mock.calls.map(([value]) => String(value)).join(''),
      );
      expect(printed.split('\n').every((line) => [...line].length <= columns)).toBe(true);
      expect(printed.replace(/[\s│]/g, '')).toContain(longPath);
    } finally {
      process.stdout.columns = previous;
      write.mockRestore();
    }
  },
);

it('конфигурация Codex корректно экранирует пути без команд оболочки и ключей', async () => {
  const { clientConfiguration } = await import('../src/interfaces/mcp-config.js');
  const config = clientConfiguration(
    'codex',
    'C:\\Tools\\node.exe',
    'C:\\Проект с пробелом\\cli.js',
    'C:\\Users\\state',
  );
  expect(config).toContain('[mcp_servers.harness]');
  const command = config.split('\n').find((line) => line.startsWith('command = '))!;
  expect(JSON.parse(command.slice('command = '.length))).toBe('C:\\Tools\\node.exe');
  expect(config).not.toContain('apiKey');
  expect(() => clientConfiguration('wrong', '', '', '')).toThrow('codex или opencode');
});
