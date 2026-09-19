import type { ProjectView } from '../../../projects/types.js';
import type { WorkIndicator } from '../work-indicator.js';

/** Объясняет реальное состояние проекта, не приписывая модели ещё не запущенные проверки. */
export function projectWork(view: ProjectView): WorkIndicator | undefined {
  if (view.blockers.some((item) => ['STORAGE_UNAVAILABLE', 'UNKNOWN_OUTCOME'].includes(item.code)))
    return { kind: 'error', label: 'Нужно проверить прерванную работу' };
  if (view.attention)
    return {
      kind: ['STORAGE_UNAVAILABLE', 'UNKNOWN_OUTCOME'].includes(view.attention.code)
        ? 'error'
        : 'waiting',
      label: view.attention.reason,
    };
  if (view.pendingApprovals) return { kind: 'waiting', label: 'Нужно ваше разрешение' };
  if (view.status === 'paused') return { kind: 'waiting', label: 'Проект приостановлен' };
  if (view.status === 'pausing') return { kind: 'busy', label: 'Завершаю операции перед паузой' };
  if (view.status === 'planning') return { kind: 'busy', label: 'Готовлю план проекта' };
  if (view.status === 'ready') return { kind: 'waiting', label: 'План ждёт вашего принятия' };
  if (view.status === 'review') return { kind: 'waiting', label: 'Результат ждёт вашей приёмки' };
  if (view.status === 'running')
    return {
      kind: 'busy',
      label: view.stages.some((stage) => stage.status === 'checking')
        ? 'Проверяю результат этапа'
        : 'Выполняю проект',
    };
  return undefined;
}
