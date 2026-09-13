import { z } from 'zod';

/** Известный отказ до принятия нового хода, отличный от потерянного ответа сервиса. */
export class SessionChangedError extends Error {
  readonly code = 'SESSION_CHANGED';
  constructor(readonly latestRunId: string) {
    super(
      'Беседа изменилась в другом окне. Откройте последний ответ перед продолжением; ваш черновик сохранён.',
    );
    this.name = 'SessionChangedError';
  }
}

/** Передаёт через IPC код конфликта и идентификатор последнего этапа беседы. */
export function sessionConflictData(
  error: unknown,
): { code: 'SESSION_CHANGED'; latestRunId: string } | undefined {
  return error instanceof SessionChangedError
    ? { code: error.code, latestRunId: error.latestRunId }
    : undefined;
}

/** Клиент принимает только известный код с валидным идентификатором задачи. */
export function sessionConflictFromData(data: unknown): SessionChangedError | undefined {
  const value = z
    .object({ code: z.literal('SESSION_CHANGED'), latestRunId: z.string().uuid() })
    .strict()
    .safeParse(data);
  return value.success ? new SessionChangedError(value.data.latestRunId) : undefined;
}
