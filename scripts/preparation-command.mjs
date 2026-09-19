import { execFile, spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** В контейнере завершённый потомок может ждать reaping, уже не удерживая файлов. */
async function hasLiveGroup(pid) {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  const entries = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  for (const entry of entries) {
    let stat;
    try {
      stat = await readFile('/proc/' + entry + '/stat', 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === pid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}

/** Дожидается остановки потомков npm, прежде чем владелец отпустит файлы и блокировку. */
async function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    await execute(
      join(systemRoot, 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      {
        windowsHide: true,
        timeout: 5000,
      },
    );
    return;
  }
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return false;
    }
  };
  if (!killGroup('SIGTERM')) return;
  // Родитель может выйти раньше потомка, который игнорирует SIGTERM.
  await new Promise((done) => setTimeout(done, 1000));
  killGroup('SIGKILL');
  const deadline = Date.now() + 2000;
  while (await hasLiveGroup(child.pid)) {
    if (Date.now() >= deadline) throw new Error('Дочерние процессы не завершились после SIGKILL.');
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Единые отмена, таймаут и ограниченный вывод для компилятора, npm и проверки runtime. */
export async function runPreparationCommand(
  root,
  args,
  {
    executable = process.execPath,
    captureOutput = false,
    stdio = 'inherit',
    signal,
    timeoutMs = 300000,
    env = process.env,
    allowFailure = false,
  } = {},
) {
  signal?.throwIfAborted();
  return await new Promise((done, fail) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : stdio,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let error;
    let stopping;
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    const stop = (reason) => {
      error ??= reason;
      stopping ??= stopProcessTree(child).catch((problem) => {
        error = new Error(
          error.message + '\nНе удалось остановить дерево процессов подготовки: ' + problem.message,
          { cause: problem },
        );
        child.kill('SIGKILL');
      });
    };
    if (captureOutput) {
      for (const name of ['stdout', 'stderr']) {
        child[name].on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) stop(new Error('Превышен размер вывода проверки runtime.'));
          else output[name].push(chunk);
        });
      }
    }
    const cancelled = () =>
      stop(signal.reason instanceof Error ? signal.reason : new Error('Подготовка отменена.'));
    const timeout = setTimeout(
      () => stop(new Error('Превышено время проверки команды подготовки.')),
      timeoutMs,
    );
    timeout.unref();
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    child.on('error', (problem) => {
      error ??= problem;
    });
    child.once('close', async (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancelled);
      await stopping;
      if (error) fail(error);
      else if (code === null || (code !== 0 && !allowFailure))
        fail(new Error('Команда подготовки завершилась с ошибкой (код ' + code + ').'));
      else
        done({
          code,
          stdout: Buffer.concat(output.stdout).toString('utf8'),
          stderr: Buffer.concat(output.stderr).toString('utf8'),
        });
    });
  });
}
