import { applicationIdentity } from '../shared/identity.js';
import type { ServiceInfo } from './types.js';

/** Несовпадение сборок видно человеку; подключение не останавливает работающий сервис. */
export function serviceCompatibility(
  service: Pick<ServiceInfo, 'version' | 'buildId' | 'protocolVersion'>,
  local = applicationIdentity(),
): string | undefined {
  if (service.protocolVersion !== undefined && service.protocolVersion !== local.protocolVersion)
    return 'Протокол сервиса отличается от CLI. Используйте CLI из установки работающего сервиса.';
  if (service.version !== local.version)
    return `CLI ${local.version}, сервис ${service.version}. Для обновления сервиса сначала завершите задачи.`;
  if (local.buildId && service.buildId && local.buildId !== service.buildId)
    return `Сборки различаются: CLI ${local.buildId.slice(0, 8)}, сервис ${service.buildId.slice(0, 8)}. Задачи продолжают работать.`;
  return undefined;
}
