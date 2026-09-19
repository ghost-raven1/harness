import { serviceCompatibility } from './service-compatibility.js';
import { runtimeVersion } from '../configuration/runtime-version.js';
import { arch, platform } from 'node:os';
import { rpc, socketPath } from './ipc.js';
import { findConfig } from '../configuration/discovery.js';
import { loadConfig } from '../configuration/loader.js';
import { message } from '../shared/primitives.js';
import type { ServiceInfo } from './types.js';
import { codexAccount } from '../providers/codex/account.js';

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

/** Диагностика читает конфигурацию даже до запуска сервиса и никогда не вызывает платный API. */
export async function diagnose(directory: string, explicitConfig?: string) {
  const checks: DiagnosticCheck[] = [
    {
      name: 'Node.js',
      status: process.version === 'v' + runtimeVersion ? 'pass' : 'fail',
      detail: process.version,
      hint:
        process.version === 'v' + runtimeVersion
          ? undefined
          : 'Установите Node.js ' + runtimeVersion + ' и повторите команду.',
    },
  ];
  let service: ServiceInfo | undefined;
  try {
    service = await rpc(directory, 'system.info');
    checks.push({ name: 'Сервис', status: 'pass', detail: directory });
    const compatibility = serviceCompatibility(service);
    checks.push({
      name: 'Совместимость сборок',
      status: compatibility ? 'warn' : 'pass',
      detail: compatibility ?? 'CLI и сервис совместимы',
    });
  } catch {
    checks.push({
      name: 'Сервис',
      status: 'warn',
      detail: 'Не запущен или недоступен',
      hint: 'Запустите harness serve в отдельном терминале с тем же --state.',
    });
  }
  const file = explicitConfig ?? service?.configFile ?? findConfig();
  let profiles = service?.profiles ?? [];
  if (file) {
    try {
      const config = await loadConfig(file);
      checks.push({ name: 'Конфигурация', status: 'pass', detail: file });
      if (!service || explicitConfig) {
        profiles = Object.entries(config.value.profiles).map(([id, profile]) => ({
          id,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          configured: !profile.apiKeyEnv || !!process.env[profile.apiKeyEnv],
        }));
      }
    } catch (error) {
      checks.push({
        name: 'Конфигурация',
        status: 'fail',
        detail: message(error),
        hint: 'Исправьте файл или создайте новый комплект: harness init.',
      });
    }
  } else if (!service) {
    checks.push({
      name: 'Конфигурация',
      status: 'fail',
      detail: 'Не найдена',
      hint: 'В папке проекта выполните harness init.',
    });
  }
  for (const profile of profiles) {
    if (profile.provider === 'codex') {
      try {
        const account = await codexAccount();
        profile.configured =
          account.loggedIn &&
          (profile.model === 'default' ||
            account.models.some((model) => model.id === profile.model));
      } catch {
        profile.configured = false;
      }
    }
    checks.push({
      name: profile.id,
      status: profile.configured ? 'pass' : 'warn',
      detail: profile.provider + ' · ' + profile.model,
      hint: profile.configured
        ? undefined
        : profile.provider === 'codex'
          ? 'Откройте Настройки → Подключить другую модель → Codex и проверьте вход.'
          : 'Задайте переменную с ключом в окружении сервиса; её имя указано в profiles.json.',
    });
  }
  return {
    ready: !!service && !checks.some((check) => check.status === 'fail'),
    platform: platform(),
    arch: arch(),
    node: process.version,
    state: directory,
    endpoint: socketPath(directory),
    transport: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
    config: file,
    checks,
    profiles,
  };
}
