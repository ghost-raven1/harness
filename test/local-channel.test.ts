import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { privateDirectory } from '../src/interfaces/local-channel.js';
import { temporary } from './helpers.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Проверяет ветку Windows через ту же границу запуска, не меняя права пользовательских папок. */
function windowsProcess(error: Error | null, duration: number): void {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.mocked(execFile)
    .mockReset()
    .mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      now += duration;
      callback(error, '', '');
      return {} as ReturnType<typeof execFile>;
    });
}

it('подтверждает защиту каталога после одного успешного вызова с прежним таймаутом', async () => {
  const directory = await temporary();
  windowsProcess(null, 25);
  await expect(privateDirectory(directory)).resolves.toBeUndefined();
  expect(execFile).toHaveBeenCalledTimes(1);
  expect(execFile).toHaveBeenCalledWith(
    win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
    expect.objectContaining({
      timeout: 15000,
      windowsHide: true,
      env: expect.objectContaining({ HARNESS_PRIVATE_DIRECTORY: directory }),
    }),
    expect.any(Function),
  );
  const args = vi.mocked(execFile).mock.calls[0]![1] as string[];
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
  expect(script).not.toMatch(/New-Object|Set-Acl/);
  expect(script).toContain('[System.Security.AccessControl.DirectorySecurity]::new()');
  expect(script).toContain('[System.Security.AccessControl.FileSystemAccessRule]::new(');
  expect(script).toContain('[System.IO.Directory]::SetAccessControl(');
  expect(script).toContain('$acl.SetOwner($identity)');
  expect(script).toContain('$acl.SetAccessRuleProtection($true, $false)');
  expect(script).not.toContain(directory);
});

it.each([
  {
    name: 'таймаут',
    fields: { code: null, signal: 'SIGTERM', killed: true },
    duration: 15003,
    reason: 'Превышено время ожидания PowerShell (15000 мс).',
    details: 'Код завершения: нет; сигнал: SIGTERM; длительность: 15003 мс.',
  },
  {
    name: 'обычный отказ',
    fields: { code: 1, signal: null, killed: false },
    duration: 125,
    reason: 'PowerShell завершился с ошибкой.',
    details: 'Код завершения: 1; сигнал: нет; длительность: 125 мс.',
  },
])('объясняет $name без EncodedCommand, сохраняя cause и запрет продолжения', async (value) => {
  const directory = await temporary();
  const cause = Object.assign(
    new Error('Command failed: powershell.exe -EncodedCommand FIXTURE'),
    value.fields,
  );
  windowsProcess(cause, value.duration);
  const error = await privateDirectory(directory).catch((problem: unknown) => problem);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ cause });
  expect((error as Error).message).toContain(value.reason);
  expect((error as Error).message).toContain(value.details);
  expect((error as Error).message).not.toContain('EncodedCommand');
  expect(execFile).toHaveBeenCalledTimes(1);
});
