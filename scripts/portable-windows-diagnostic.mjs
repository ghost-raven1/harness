import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const stages = new Set(['start', 'identity', 'directory', 'owner', 'rule', 'apply', 'done']);

/** Измеряет тот же ACL и прямой .NET-вариант, не выводя пути или текст исключений. */
function diagnosticScript(method) {
  const commands = [
    ['identity', '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User'],
    [
      'directory',
      method === 'cmdlets'
        ? '$acl = New-Object System.Security.AccessControl.DirectorySecurity'
        : '$acl = [System.Security.AccessControl.DirectorySecurity]::new()',
    ],
    ['owner', '$acl.SetOwner($identity); $acl.SetAccessRuleProtection($true, $false)'],
    [
      'rule',
      method === 'cmdlets'
        ? "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule)"
        : "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule)",
    ],
    [
      'apply',
      method === 'cmdlets'
        ? 'Set-Acl -LiteralPath $env:HARNESS_PRIVATE_DIRECTORY -AclObject $acl'
        : '[System.IO.Directory]::SetAccessControl($env:HARNESS_PRIVATE_DIRECTORY, $acl)',
    ],
  ];
  const emit = (code) =>
    `[Console]::Out.WriteLine(('HARNESS_ACL|{0}|{1}|{2}' -f $stage, $watch.ElapsedMilliseconds, ${code}))`;
  return [
    "$ErrorActionPreference = 'Stop'",
    '$watch = [System.Diagnostics.Stopwatch]::StartNew()',
    "$stage = 'start'",
    emit("'ok'"),
    'try {',
    ...commands.flatMap(([stage, command]) => [
      `$stage = '${stage}'`,
      emit("'start'"),
      command,
      emit("'ok'"),
    ]),
    "$stage = 'done'",
    emit("'ok'"),
    '} catch {',
    emit('$_.Exception.HResult'),
    'exit 1',
    '}',
  ].join('\n');
}

/** Принимает только заранее известные метки; stderr и пользовательские пути в отчёт не попадают. */
function stageRows(method, stdout) {
  const rows = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    const match = /^HARNESS_ACL\|([a-z]+)\|(\d{1,10})\|(start|ok|-?\d{1,12})$/.exec(line);
    if (!match || !stages.has(match[1]) || rows.length >= 32) continue;
    rows.push({
      stage: method + '.' + match[1],
      elapsedMs: Number(match[2]),
      code: /^-?\d+$/.test(match[3]) ? Number(match[3]) : match[3],
    });
  }
  return rows;
}

/** Два процесса по 15 секунд используют разные временные каталоги и исходное окружение probe. */
async function diagnoseWindowsAcl(parent, env) {
  const rows = [];
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  if (!systemRoot) return [{ stage: 'setup', elapsedMs: 0, code: 'system-root-missing' }];
  const root = await mkdtemp(join(parent, 'acl-diagnostic-'));
  try {
    for (const method of ['cmdlets', 'dotnet']) {
      const directory = join(root, method);
      await mkdir(directory);
      const startedAt = Date.now();
      try {
        const result = await execute(
          win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(diagnosticScript(method), 'utf16le').toString('base64'),
          ],
          {
            cwd: directory,
            env: { ...env, HARNESS_PRIVATE_DIRECTORY: directory },
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 64 * 1024,
          },
        );
        rows.push(...stageRows(method, result.stdout));
        rows.push({ stage: method + '.process', elapsedMs: Date.now() - startedAt, code: 0 });
      } catch (error) {
        rows.push(...stageRows(method, error.stdout));
        rows.push({
          stage: method + '.process',
          elapsedMs: Date.now() - startedAt,
          code:
            error.killed && error.code === null
              ? 'timeout'
              : typeof error.code === 'number'
                ? error.code
                : 'process-error',
        });
      }
    }
  } finally {
    const startedAt = Date.now();
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      rows.push({ stage: 'cleanup', elapsedMs: Date.now() - startedAt, code: 0 });
    } catch {
      rows.push({ stage: 'cleanup', elapsedMs: Date.now() - startedAt, code: 'cleanup-error' });
    }
  }
  return rows;
}

/** Собирает диагностику только после отказа Windows; исходная ошибка остаётся причиной провала. */
export async function probeWithWindowsDiagnostics(probe, parent, env, record) {
  try {
    return await probe();
  } catch (primaryError) {
    if (process.platform === 'win32') {
      let rows;
      const startedAt = Date.now();
      try {
        rows = await diagnoseWindowsAcl(parent, env);
      } catch {
        rows = [{ stage: 'diagnostic', elapsedMs: Date.now() - startedAt, code: 'unavailable' }];
      }
      try {
        await record(rows);
      } catch {
        // Ошибка записи диагностики не подменяет исходный отказ portable-проверки.
      }
    }
    throw primaryError;
  }
}
