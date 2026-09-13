export type MissingResource = 'task' | 'lesson' | 'draft';

/** Отсутствие записи отличается от временной недоступности локального сервиса. */
export class ResourceNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';
  constructor(readonly resource: MissingResource) {
    super(
      resource === 'task'
        ? 'Unknown run'
        : resource === 'draft'
          ? 'Черновик удалён в другом окне. Вернитесь к выбору задачи.'
          : 'Урок уже удалён. Вернитесь к списку знаний.',
    );
    this.name = 'ResourceNotFoundError';
  }
}

/** Отличает отсутствие конкретного вида записи от прочих ошибок. */
export function isMissingResource(error: unknown, resource: MissingResource): boolean {
  return error instanceof ResourceNotFoundError && error.resource === resource;
}

/** Через IPC передаются только два известных признака, без содержимого исключения. */
export function resourceErrorData(
  error: unknown,
): { code: 'RESOURCE_NOT_FOUND'; resource: MissingResource } | undefined {
  return error instanceof ResourceNotFoundError
    ? { code: error.code, resource: error.resource }
    : undefined;
}

/** Восстанавливает только известную ошибку отсутствия записи из ответа IPC. */
export function resourceErrorFromData(data: unknown): ResourceNotFoundError | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = data as Record<string, unknown>;
  return value.code === 'RESOURCE_NOT_FOUND' &&
    (value.resource === 'task' || value.resource === 'lesson' || value.resource === 'draft')
    ? new ResourceNotFoundError(value.resource)
    : undefined;
}
