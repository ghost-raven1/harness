import { ProviderError, type ProviderLimit } from './errors.js';

const quotaCodes = new Set([
  'insufficient_quota',
  'quota_exceeded',
  'billing_hard_limit_reached',
  'usage_limit_exceeded',
  'credits_exhausted',
  'insufficient_balance',
]);
const rateCodes = new Set([
  'rate_limit_exceeded',
  'rate_limit_error',
  'rate_limit_reached',
  'resource_exhausted',
  'too_many_requests',
]);

/** Нормализует объект ошибки для чтения полей; массивы и простые значения отбрасывает. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Читает только поля протокола ошибки, никогда не анализируя текст ответа модели. */
export function providerLimit(
  value: unknown,
  status?: number,
  headers?: Record<string, string>,
): ProviderLimit | undefined {
  const envelope = record(value);
  const detail =
    envelope.error && typeof envelope.error === 'object' ? record(envelope.error) : envelope;
  const codes = [detail.code, detail.type, detail.status]
    .filter((code): code is string => typeof code === 'string')
    .map((code) => code.toLowerCase());
  const kind =
    status === 402 || codes.some((code) => quotaCodes.has(code))
      ? 'quota'
      : status === 429 || detail.code === 429 || codes.some((code) => rateCodes.has(code))
        ? 'rate_limit'
        : undefined;
  if (!kind) return undefined;
  const retryAt = retryAfter(headers);
  return { kind, ...(retryAt ? { retryAt } : {}) };
}

/** Поддерживает Retry-After в секундах и HTTP-date; неверное значение не задаёт ожидание. */
export function retryAfter(headers?: Record<string, string>, now = Date.now()): string | undefined {
  const value = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
    ?.trim();
  if (!value) return undefined;
  const time = /^\d+(?:\.\d+)?$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(time) && time > now && time <= 8.64e15
    ? new Date(time).toISOString()
    : undefined;
}

/** Создаёт типизированную ошибку ограничения с причиной и подсказкой о продолжении. */
export function limitError(limit: ProviderLimit): ProviderError {
  const description =
    limit.kind === 'quota'
      ? 'Провайдер сообщил, что доступная квота или баланс исчерпаны. Проверьте лимиты аккаунта и оплату, затем продолжите сохранённую задачу.'
      : 'Провайдер временно ограничил частоту запросов. Задача сохранена на паузе; продолжите её после снятия ограничения.';
  return new ProviderError(description, limit.kind === 'rate_limit', false, limit);
}

/** Нормализует документированные ошибки app-server; сообщение сервера остаётся непрозрачным. */
export function codexProviderError(value: unknown, fallback: string): ProviderError {
  const error = record(value);
  const data = record(error.data);
  const info = error.codexErrorInfo ?? data.codexErrorInfo;
  if (info === 'usageLimitExceeded' || info === 'sessionBudgetExceeded')
    return limitError({ kind: 'quota' });
  if (info === 'rateLimitExceeded') return limitError({ kind: 'rate_limit' });
  if (info === 'contextWindowExceeded')
    return new ProviderError('Codex: CONTEXT_LIMIT', false, true);
  const tagged = record(info);
  for (const name of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ]) {
    const status = record(tagged[name]).httpStatusCode;
    const limit = providerLimit(undefined, typeof status === 'number' ? status : undefined);
    if (limit) return limitError(limit);
  }
  const limit = providerLimit(data, typeof error.code === 'number' ? error.code : undefined);
  return limit ? limitError(limit) : new ProviderError(fallback);
}
