import { spawn } from 'node:child_process';

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
    });
    let error;
    let force;
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    const stop = (reason) => {
      error ??= reason;
      if (force) return;
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 1000);
      force.unref();
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
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(force);
      signal?.removeEventListener('abort', cancelled);
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
