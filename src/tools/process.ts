import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { win32 } from 'node:path';
import type { ToolContext } from './registry.js';
import { abort } from '../shared/primitives.js';

const executeFile = promisify(execFile);
const maxOutputCharacters = 1048576;
interface CapturedOutput {
  text: string;
  truncated: boolean;
}

function capture(output: CapturedOutput, chunk: string): void {
  const remaining = maxOutputCharacters - output.text.length;
  if (chunk.length > remaining) output.truncated = true;
  if (remaining > 0) output.text += chunk.slice(0, remaining);
}

/** Передаёт программам только системные переменные, без ключей моделей и MCP. */
export function processEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const names =
    platform === 'win32'
      ? ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']
      : ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'];
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const entry = Object.entries(source).find(([key]) =>
      platform === 'win32' ? key.toUpperCase() === name : key === name,
    );
    if (entry) result[name] = entry[1];
  }
  return result;
}

/** Останавливает только дерево переданного процесса: группу POSIX или taskkill /T в Windows. */
export async function stopProcessTree(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process ID');
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root) throw new Error('SystemRoot is required to stop a Windows process tree');
    await executeFile(
      win32.join(root, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5000,
      },
    );
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

/** Исполняет буквальный argv; shell запускается явно, потерянный хвост каждого потока отмечается отдельно. */
export function executeProgram(
  command: string,
  args: string[],
  context: Pick<ToolContext, 'workspace' | 'signal'>,
): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw new Error(
      'Windows batch files require an explicitly approved cmd.exe call; use node.exe for JavaScript CLIs',
    );
  }
  return new Promise((resolve, reject) => {
    abort(context.signal);
    const child = spawn(command, args, {
      cwd: context.workspace,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: processEnvironment(),
    });
    const stdout: CapturedOutput = { text: '', truncated: false };
    const stderr: CapturedOutput = { text: '', truncated: false };
    const stop = (): void => {
      if (!child.pid) return;
      void stopProcessTree(child.pid).catch(() => {
        // Если дерево уже изменилось, всё равно пытаемся завершить известного прямого потомка.
        child.kill('SIGKILL');
      });
    };
    context.signal.addEventListener('abort', stop, { once: true });
    if (context.signal.aborted) stop();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      capture(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      capture(stderr, chunk);
    });
    child.on('error', (error) => {
      context.signal.removeEventListener('abort', stop);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      context.signal.removeEventListener('abort', stop);
      if (context.signal.aborted) {
        reject(new Error('Command cancelled or timed out; partial effects may exist'));
        return;
      }
      resolve({
        exitCode,
        signal,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdout: stdout.text,
        stderr: stderr.text,
      });
    });
  });
}
