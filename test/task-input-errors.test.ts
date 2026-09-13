import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import { taskInputSaveMessage } from '../src/interfaces/guided/task-input.js';

it.each([
  'Local service unavailable. /private/account/API_SECRET',
  'Local service request timed out',
  'Local service closed the connection before completion',
  'connect ECONNREFUSED /private/account/control.sock',
])('ошибка транспорта помещается в 48 колонок и объясняет, где остался текст: %s', (detail) => {
  const notice = taskInputSaveMessage(new Error(detail));
  expect(stringWidth(notice)).toBeLessThanOrEqual(43);
  expect(notice).toContain('Текст');
  expect(notice).not.toMatch(/[a-zA-Z/]/);
});

it('ошибки места и доступа различаются, неизвестная ошибка не раскрывает внутренние данные', () => {
  const disk = taskInputSaveMessage(new Error('ENOSPC /private/file'));
  const access = taskInputSaveMessage(new Error('EACCES /private/file'));
  const unknown = taskInputSaveMessage(new Error('PRIVATE_SENTINEL'));
  expect(new Set([disk, access, unknown]).size).toBe(3);
  for (const notice of [disk, access, unknown]) {
    expect(stringWidth(notice)).toBeLessThanOrEqual(43);
    expect(notice).not.toMatch(/PRIVATE_SENTINEL|private/);
  }
});
