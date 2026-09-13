import type { ToolInvocation } from './types.js';

/** Начатая запись без подтверждённого результата требует проверки, даже если задача уже остановлена. */
export function requiresOutcomeReview(invocation: ToolInvocation): boolean {
  return (
    invocation.status === 'unknown' ||
    (invocation.status === 'started' && invocation.effect === 'write')
  );
}
