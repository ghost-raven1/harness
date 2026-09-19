import { it, expect } from 'vitest';
import { posix, win32, join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { isWithin } from '../src/configuration/loader.js';
import { socketPath, checkAccessToken } from '../src/interfaces/local-channel.js';
import { processEnvironment, executeProgram } from '../src/tools/process.js';
import { temporary, cleanup, configDirectory } from './helpers.js';
import { serve, rpc } from '../src/interfaces/ipc.js';

it.each([
  [posix, '/work/project', '/work/project/a', true],
  [posix, '/work/project', '/work/private/a', false],
  [posix, '/work/project', '/work/project-other', false],
  [win32, 'C:\\work\\project', 'C:\\work\\project\\a', true],
  [win32, 'C:\\work\\project', 'C:\\work\\private\\a', false],
  [win32, 'C:\\work\\project', 'C:\\work\\project-other', false],
  [win32, 'C:\\work\\project', 'D:\\work\\project', false],
  [win32, '\\\\host\\share\\project', '\\\\host\\share\\secret', false],
] as const)('границы workspace учитывают систему путей %#', (paths, root, target, expected) => {
  expect(isWithin(root, target, paths)).toBe(expected);
});

it('канал Windows имеет стабильное имя при изменении регистра и разделителей', () => {
  expect(socketPath('C:\\Users\\User\\State', 'win32')).toBe(
    socketPath('c:/users/user/state', 'win32'),
  );
  expect(socketPath('C:\\Users\\User\\State', 'win32')).toMatch(
    /^\\\\\.\\pipe\\harness-[a-f0-9]{24}$/,
  );
});

it('отклоняет отсутствующий или чужой токен локального канала', () => {
  expect(() => checkAccessToken('a'.repeat(64), undefined)).toThrow('authentication');
  expect(() => checkAccessToken('a'.repeat(64), 'b'.repeat(64))).toThrow('authentication');
  expect(() => checkAccessToken('a'.repeat(64), 'я'.repeat(64))).toThrow('authentication');
  expect(() => checkAccessToken('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
});

it('Windows получает системные переменные, но не ключи моделей', () => {
  const env = processEnvironment(
    {
      Path: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      MODEL_API_KEY: 'secret',
      QWEN_API_KEY: 'secret',
    },
    'win32',
  );
  expect(env).toEqual({ PATH: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp' });
});

it('длинный путь состояния с пробелами и кириллицей работает через настоящий IPC', async () => {
  const root = await temporary();
  const directory = join(root, 'длинный проект с пробелами '.repeat(5), 'state');
  const service = await serve(await configDirectory(root, 'http://127.0.0.1:1/v1'), directory);
  cleanup(() => service.close());
  const result = await rpc(directory, 'system.info');
  expect(result.node).toBe(process.version);
  expect(Buffer.byteLength(socketPath(directory))).toBeLessThanOrEqual(100);
});

it('процесс получает буквальные аргументы и сохраняет кириллицу между порциями stdout', async () => {
  const workspace = join(await temporary(), 'проект с пробелами');
  await mkdir(workspace);
  const result = await executeProgram(
    process.execPath,
    [
      '-e',
      "const b=Buffer.from('Японский ёж'); process.stdout.write(b.subarray(0,1)); setTimeout(()=>process.stdout.write(b.subarray(1)),20); require('fs').writeFileSync('argv',process.argv[1])",
      'literal $(nothing) & text',
    ],
    { workspace, signal: new AbortController().signal },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('Японский ёж');
  expect(await readFile(join(workspace, 'argv'), 'utf8')).toBe('literal $(nothing) & text');
});

it('отмена останавливает запущенную программу', async () => {
  const workspace = await temporary();
  const controller = new AbortController();
  const result = executeProgram(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    workspace,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(result).rejects.toThrow('cancelled');
  } finally {
    clearTimeout(timer);
  }
});
