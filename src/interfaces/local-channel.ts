import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, lstat, chmod, readFile, writeFile, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

/** Именованный канал Windows не зависит от длины пути; Unix сохраняет прежний адрес, если он помещается. */
export function socketPath(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonical = platform === 'win32' ? win32.resolve(directory).toLowerCase() : directory;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  if (platform === 'win32') return '\\\\.\\pipe\\harness-' + hash;
  const original = join(directory, 'control.sock');
  if (Buffer.byteLength(original) <= 100) return original;
  const shortened = join(tmpdir(), 'harness-' + userInfo().uid, hash + '.sock');
  if (Buffer.byteLength(shortened) > 100)
    throw new Error('Temporary directory path is too long for IPC; choose a shorter TMPDIR');
  return shortened;
}

/** Защищает только каталог состояния сервиса; ключ доступа не попадает в сообщения модели. */
export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('State directory must be a real directory');
  if (process.platform !== 'win32') {
    if (metadata.uid !== userInfo().uid) throw new Error('State directory belongs to another user');
    await chmod(directory, 0o700);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error('SystemRoot is required to protect the state directory');
  // Передача пути через окружение исключает подстановку пользовательского текста в PowerShell-код.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = New-Object System.Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($identity)',
    '$acl.SetAccessRuleProtection($true, $false)',
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $env:HARNESS_PRIVATE_DIRECTORY -AclObject $acl',
  ].join('; ');
  const startedAt = Date.now();
  try {
    await executeFile(
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        env: { ...process.env, HARNESS_PRIVATE_DIRECTORY: directory },
        windowsHide: true,
        timeout: 15000,
      },
    );
  } catch (cause) {
    const failure = cause as { code?: string | number | null; signal?: string; killed?: boolean };
    const reason =
      failure.killed && failure.code === null
        ? 'Превышено время ожидания PowerShell (15000 мс).'
        : 'PowerShell завершился с ошибкой.';
    throw new Error(
      `Не удалось подтвердить защиту каталога состояния Windows. ${reason} ` +
        `Код завершения: ${failure.code ?? 'нет'}; сигнал: ${failure.signal ?? 'нет'}; ` +
        `длительность: ${Math.max(0, Date.now() - startedAt)} мс.`,
      { cause },
    );
  }
}

/** Создаёт токен доступа к именованному каналу Windows; Unix использует права сокета. */
export async function createAccessToken(directory: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  const token = randomBytes(32).toString('hex');
  await writeFile(join(directory, 'control.token'), token, { mode: 0o600 });
  return token;
}

/** Читает токен Windows из защищённого каталога состояния. */
export async function readAccessToken(directory: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;
  return readFile(join(directory, 'control.token'), 'utf8');
}

/** Проверяет токен без сравнения содержимого по времени; Unix-канал токена не требует. */
export function checkAccessToken(expected: string | undefined, actual: string | undefined): void {
  if (expected === undefined) return;
  const reference = Buffer.from(expected);
  const received = Buffer.from(actual ?? '');
  if (reference.length !== received.length || !timingSafeEqual(reference, received)) {
    throw new Error('Local service authentication failed');
  }
}

/** Удаляет токен Windows при освобождении каталога сервиса. */
export async function removeAccessToken(directory: string): Promise<void> {
  if (process.platform === 'win32')
    await unlink(join(directory, 'control.token')).catch(() => undefined);
}
