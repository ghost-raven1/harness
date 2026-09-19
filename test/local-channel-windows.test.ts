import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { temporary } from './helpers.js';

const execute = promisify(execFile);
const { portableEnvironment } = await import(
  pathToFileURL(resolve('scripts/portable-check.mjs')).href
);

test.skipIf(process.platform !== 'win32')(
  'защищает каталог в пустом профиле Windows и сохраняет ACL только текущего пользователя',
  async () => {
    const root = await temporary();
    const profile = join(root, 'чистый профиль');
    await mkdir(profile);
    const directory = join(root, 'Состояние [ACL] с пробелами');
    const env = {
      ...portableEnvironment(profile, resolve('scripts/portable-offline.mjs')),
      HARNESS_PRIVATE_DIRECTORY: directory,
    };
    // Отдельный Node использует настоящее изолированное окружение, не меняя окружение Vitest.
    const source = pathToFileURL(resolve('src/interfaces/local-channel.ts')).href;
    const applied = await execute(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { privateDirectory } from ${JSON.stringify(source)}; ` +
          'await privateDirectory(process.env.HARNESS_PRIVATE_DIRECTORY); console.log("protected");',
      ],
      { env, timeout: 20000, windowsHide: true },
    );
    expect(applied.stdout.trim()).toBe('protected');
    // Читаем установленную ACL с диска через .NET, без cmdlets и поиска модулей PowerShell.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
      '$acl = [System.IO.Directory]::GetAccessControl($env:HARNESS_PRIVATE_DIRECTORY)',
      '$rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])',
      'if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) { exit 11 }',
      'if (-not $acl.AreAccessRulesProtected) { exit 12 }',
      'if ($rules.Count -ne 1) { exit 13 }',
      '$rule = $rules[0]',
      'if ($rule.IdentityReference.Value -ne $identity.Value -or $rule.IsInherited) { exit 14 }',
      "if ($rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { exit 15 }",
      "if ($rule.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None') { exit 16 }",
      "[Console]::Out.WriteLine('acl-confirmed')",
    ].join('; ');
    const inspected = await execute(
      win32.join(
        env.SystemRoot ?? env.SYSTEMROOT,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { env, timeout: 15000, windowsHide: true },
    );
    expect(inspected.stdout.trim()).toBe('acl-confirmed');
  },
  40000,
);
