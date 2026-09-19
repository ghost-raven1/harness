import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { temporary } from './helpers.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
const { probeWithWindowsDiagnostics } = await import(
  pathToFileURL(resolve('scripts/portable-windows-diagnostic.mjs')).href
);
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.mocked(execFile).mockReset();
});

/** Эмулирует только запуск PowerShell; каталоги диагностики создаются и удаляются настоящей ФС. */
function windows(): void {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
}

test.each(['win32', 'linux'])('успешный probe на %s не запускает диагностику', async (value) => {
  Object.defineProperty(process, 'platform', { ...platform, value });
  const record = vi.fn();
  await expect(
    probeWithWindowsDiagnostics(async () => 'готово', '/unused', {}, record),
  ).resolves.toBe('готово');
  expect(execFile).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test('ошибка другой системы не запускает PowerShell и остаётся исходной', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const failure = new Error('исходный отказ');
  const record = vi.fn();
  await expect(
    probeWithWindowsDiagnostics(async () => Promise.reject(failure), '/unused', {}, record),
  ).rejects.toBe(failure);
  expect(execFile).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

test('после таймаута сравнивает ACL, сохраняет только стадии и очищает отдельные папки', async () => {
  const root = await temporary();
  windows();
  const env = { SystemRoot: 'C:\\Windows', PATH: '', HOME: 'отдельный профиль' };
  const scripts: string[] = [];
  const directories: string[] = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const options = args[2] as { cwd: string; env: Record<string, string> };
    const callback = args.at(-1) as (error: Error | null, result: unknown, stderr: string) => void;
    scripts.push(Buffer.from((args[1] as string[]).at(-1)!, 'base64').toString('utf16le'));
    directories.push(options.cwd);
    expect(options.env).toEqual({ ...env, HARNESS_PRIVATE_DIRECTORY: options.cwd });
    const stdout =
      'HARNESS_ACL|identity|1|ok\r\nHARNESS_ACL|apply|12|start\r\n' +
      'HARNESS_ACL|private-path|1|ok\nHARNESS_ACL|apply|12|C:\\secret\n';
    if (scripts.length === 1) {
      callback(
        Object.assign(new Error('SECRET'), {
          killed: true,
          code: null,
          signal: 'SIGTERM',
          stdout,
          stderr: 'SECRET C:\\private',
        }),
        stdout,
        'SECRET',
      );
    } else {
      // Настоящий execFile имеет специальный promisify, возвращающий оба потока объектом.
      callback(null, { stdout: stdout + 'HARNESS_ACL|done|15|ok\n', stderr: 'SECRET' }, '');
    }
    return {} as ReturnType<typeof execFile>;
  });
  const primary = new Error('исходный отказ');
  const record = vi.fn();
  await expect(
    probeWithWindowsDiagnostics(async () => Promise.reject(primary), root, env, record),
  ).rejects.toBe(primary);
  expect(execFile).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(execFile).mock.calls) {
    expect(call[0]).toBe(
      win32.join('C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    );
    expect(call[2]).toMatchObject({ timeout: 15000, maxBuffer: 65536, windowsHide: true });
  }
  expect(scripts[0]).toContain('New-Object System.Security.AccessControl.DirectorySecurity');
  expect(scripts[0]).toContain('Set-Acl -LiteralPath');
  expect(scripts[1]).toContain('[System.Security.AccessControl.DirectorySecurity]::new()');
  expect(scripts[1]).toContain('[System.Security.AccessControl.FileSystemAccessRule]::new(');
  expect(scripts[1]).toContain('[System.IO.Directory]::SetAccessControl(');
  expect(scripts[1]).not.toMatch(/New-Object|Set-Acl/);
  expect(directories[0]).not.toBe(directories[1]);
  for (const directory of directories)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(root)).toEqual([]);
  const rows = record.mock.calls[0]![0];
  expect(rows).toContainEqual({
    stage: 'cmdlets.process',
    elapsedMs: expect.any(Number),
    code: 'timeout',
  });
  expect(rows).toContainEqual({ stage: 'dotnet.done', elapsedMs: 15, code: 'ok' });
  expect(rows).toContainEqual({ stage: 'cleanup', elapsedMs: expect.any(Number), code: 0 });
  expect(JSON.stringify(rows)).not.toMatch(/SECRET|private-path|C:|HARNESS_PRIVATE_DIRECTORY/);
});

test('отказ записи диагностики не превращает исходный failure в другой результат', async () => {
  windows();
  const primary = new Error('исходный отказ');
  const record = vi.fn(() => {
    throw new Error('полон диск');
  });
  await expect(
    probeWithWindowsDiagnostics(async () => Promise.reject(primary), '/unused', {}, record),
  ).rejects.toBe(primary);
  expect(execFile).not.toHaveBeenCalled();
  expect(record).toHaveBeenCalledWith([
    { stage: 'setup', elapsedMs: 0, code: 'system-root-missing' },
  ]);
});
