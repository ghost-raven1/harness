import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const helper = pathToFileURL(resolve('scripts/preparation-command.mjs')).href;

it('ошибка завершения дерева дополняет исходный таймаут', async () => {
  await expect(
    execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
if(process.platform==='win32') {
  const original=childProcess.execFile;
  childProcess.execFile=(file,args,options,callback)=>original(process.execPath,
    ['-e',"process.stderr.write('TREE_STOP_FAILURE');process.exitCode=1;"],options,callback);
  syncBuiltinESMExports();
} else {
  const original=process.kill;
  process.kill=(pid,signal)=>{if(pid<0)throw new Error('TREE_STOP_FAILURE');return original(pid,signal);};
}
const {runPreparationCommand}=await import(${JSON.stringify(helper)});
await runPreparationCommand(process.cwd(),['-e','setInterval(()=>{},1000)'],{timeoutMs:200,stdio:'ignore'});`,
      ],
      { timeout: 8000 },
    ),
  ).rejects.toThrow(/Превышено время[\s\S]+TREE_STOP_FAILURE/);
});

it.each(['timeout', 'abort'])(
  '%s завершает потомка, даже когда родитель уже закрыл свой вывод',
  async (mode) => {
    const root = await temporary();
    const heartbeat = join(root, 'heartbeat.txt');
    const pidFile = join(root, 'descendant.pid');
    const worker = join(root, 'worker.cjs');
    const descendant = `const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const file=fs.openSync(${JSON.stringify(heartbeat)},'a');
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
setInterval(()=>fs.writeSync(file,'.'),20);`;
    await writeFile(
      worker,
      `const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
process.on('SIGTERM',()=>process.exit(0));
setInterval(()=>{},1000);`,
    );
    let pid: number | undefined;
    try {
      const result = await execute(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runPreparationCommand} from ${JSON.stringify(helper)};
import {access,open} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
const controller=new AbortController();
const log=await open(${JSON.stringify(join(root, 'command.log'))},'a');
const outcome=runPreparationCommand(${JSON.stringify(root)},[${JSON.stringify(worker)}],{
  signal:controller.signal,timeoutMs:2000,stdio:['ignore',log.fd,log.fd]
}).then(()=>({success:true}),error=>({error:error.message}));
if(${JSON.stringify(mode)}==='abort') {
  for(let attempt=0;attempt<200;attempt++) {
    if(await access(${JSON.stringify(pidFile)}).then(()=>true,()=>false)) break;
    await setTimeout(10);
  }
  controller.abort(new Error('Остановка по запросу'));
}
console.log(JSON.stringify(await outcome));
await log.close();`,
        ],
        { timeout: 8000 },
      );
      pid = Number(await readFile(pidFile, 'utf8'));
      expect(pid).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout).error).toContain(
        mode === 'abort' ? 'Остановка по запросу' : 'Превышено время',
      );
      if (process.platform === 'linux') {
        const state = await readFile('/proc/' + pid + '/stat', 'utf8').then(
          (stat) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0],
          () => 'gone',
        );
        expect(['gone', 'Z', 'X']).toContain(state);
      } else if (process.platform === 'darwin') {
        let exists = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          exists = false;
        }
        if (exists) {
          // PID может ещё существовать после завершения исполнителя, пока ОС не собрала его статус.
          const state = await execute('/bin/ps', ['-o', 'stat=', '-p', String(pid)]).then(
            ({ stdout }) => stdout.trim(),
            (error: unknown) => {
              const failure = error as { code?: number; stdout?: string; stderr?: string };
              if (
                failure.code === 1 &&
                failure.stdout?.trim() === '' &&
                failure.stderr?.trim() === ''
              )
                return 'gone';
              throw error;
            },
          );
          expect(['gone', 'Z', 'X']).toContain(state === 'gone' ? state : state[0]);
        }
      } else expect(() => process.kill(pid!, 0)).toThrow();
      // В Windows открытый потомком файл помешал бы удалить временный проект.
      await rm(root, { recursive: true });
    } finally {
      pid ??= await readFile(pidFile, 'utf8').then(Number, () => undefined);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Проверенный потомок уже завершился. */
        }
      }
    }
  },
);
