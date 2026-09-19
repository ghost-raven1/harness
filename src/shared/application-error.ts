import { z } from 'zod';

export const applicationErrorCodeSchema = z.enum([
  'TASK_BUSY',
  'STALE_PREVIEW',
  'UNKNOWN_OUTCOME',
  'STORAGE_UNAVAILABLE',
  'INCOMPATIBLE_PROTOCOL',
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'UNKNOWN_COMMAND',
  'PROJECT_MANAGED',
  'PROJECT_CONFLICT',
  'PROJECT_CHANGED',
  'INVALID_PLAN',
]);
export type ApplicationErrorCode = z.infer<typeof applicationErrorCodeSchema>;

/** Код определяет восстановление интерфейса независимо от языка технического сообщения. */
export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApplicationError';
  }
}

/** Передаёт только стабильный код; внутренние причины не попадают в протокол. */
export function applicationErrorData(error: unknown): { code: ApplicationErrorCode } | undefined {
  if (error instanceof ApplicationError) return { code: error.code };
  if (error instanceof z.ZodError) return { code: 'INVALID_REQUEST' };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && ['ENOSPC', 'EIO', 'EROFS', 'EDQUOT'].includes(code))
    return { code: 'STORAGE_UNAVAILABLE' };
  return undefined;
}

/** Восстанавливает типизированную ошибку сервиса после проверки полученного кода. */
export function applicationErrorFromData(
  data: unknown,
  message: string,
): ApplicationError | undefined {
  const value = z.object({ code: applicationErrorCodeSchema }).safeParse(data);
  return value.success ? new ApplicationError(value.data.code, message) : undefined;
}
