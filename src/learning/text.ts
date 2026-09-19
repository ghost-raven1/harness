import type { LearningCandidate } from './types.js';
import { plainText } from '../shared/plain-text.js';

export const lessonLabels: Record<LearningCandidate['status'], string> = {
  candidate: 'Кандидат',
  evaluating: 'Проверяется',
  published: 'Опубликован',
  rejected: 'Отклонён',
  revoked: 'Отозван',
};

/** Скрывает распространённые форматы ключей даже у отклонённых кандидатов. */
export function knowledgeText(value: string): string {
  return plainText(value)
    .replace(/\bsk-[a-z0-9_-]{12,}/gi, '[ключ скрыт]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+/gi, 'Bearer [ключ скрыт]')
    .replace(
      /((?:api[_ -]?key|password|secret|access[_ -]?token|token)["']?\s*[:=]\s*["']?)[^\s"',;\}\]]+/gi,
      '$1[ключ скрыт]',
    );
}
