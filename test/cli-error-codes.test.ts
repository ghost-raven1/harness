import { expect, it } from 'vitest';
import { cliErrorResult } from '../src/interfaces/cli.js';
import { explainError } from '../src/interfaces/guided/errors.js';
import { ApplicationError, applicationErrorCodeSchema } from '../src/shared/application-error.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';

it.each(applicationErrorCodeSchema.options)(
  'CLI сохраняет код %s и выбирает понятное действие',
  (code) => {
    const error = new ApplicationError(code, 'Техническая причина');
    expect(cliErrorResult(error)).toEqual({ error: 'Техническая причина', code });
    expect(explainError(error)).not.toBe('Техническая причина');
    expect(explainError(error)).toMatch(/[А-Яа-я]/u);
  },
);

it('CLI сохраняет сведения об удалённом ресурсе и не выдаёт исключение целиком', () => {
  expect(cliErrorResult(new ResourceNotFoundError('task'))).toEqual({
    error: 'Unknown run',
    code: 'RESOURCE_NOT_FOUND',
    resource: 'task',
  });
  const cause = Object.assign(new Error('disk path contains private data'), { code: 'ENOSPC' });
  const error = new ApplicationError('STORAGE_UNAVAILABLE', 'Не удалось сохранить', { cause });
  expect(JSON.stringify(cliErrorResult(error))).not.toContain('private data');
  expect(cliErrorResult(new Error('Прочая ошибка'))).toEqual({ error: 'Прочая ошибка' });
});
