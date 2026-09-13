import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const helper = pathToFileURL(resolve('scripts/preparation-command.mjs')).href;

/** Отдельный процесс проверяет настоящий spawn и ограничение вывода до разбора результата. */
function command(code: string, options: Record<string, unknown> = {}) {
  return execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {runPreparationCommand} from ${JSON.stringify(helper)};
console.log(JSON.stringify(await runPreparationCommand(process.cwd(),['-e',${JSON.stringify(code)}],${JSON.stringify({ captureOutput: true, timeoutMs: 2000, ...options })})));`,
    ],
    { timeout: 5000 },
  );
}

it('собирает UTF-8 между порциями и сохраняет оба канала вывода', async () => {
  const result = await command(
    "process.stdout.write(Buffer.from([0xd0]));setImmediate(()=>{process.stdout.write(Buffer.from([0xaf]));process.stderr.write('диагностика');});",
  );
  expect(JSON.parse(result.stdout)).toEqual({ code: 0, stdout: 'Я', stderr: 'диагностика' });
});

it('проверка дерева зависимостей может получить ненулевой код без потери диагностики', async () => {
  const result = await command("process.stderr.write('нет пакета');process.exitCode=17;", {
    allowFailure: true,
  });
  expect(JSON.parse(result.stdout)).toEqual({ code: 17, stdout: '', stderr: 'нет пакета' });
});

it('общий предел stdout и stderr останавливает многословную проверку runtime', async () => {
  await expect(
    command(
      "process.stdout.write('a'.repeat(33*1024));process.stderr.write('b'.repeat(33*1024));setInterval(()=>{},1000);",
    ),
  ).rejects.toThrow('Превышен размер вывода');
});

it('отсутствующий runtime возвращает ошибку запуска без зависания', async () => {
  await expect(
    command('', { executable: resolve('missing-runtime-fixture/node') }),
  ).rejects.toThrow('ENOENT');
});
