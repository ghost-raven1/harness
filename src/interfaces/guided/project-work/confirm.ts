import type { ProjectView } from '../../../projects/types.js';
import type { CliContext } from '../../types.js';
import { liveConfirm } from '../live-confirm.js';

/** Решение относится только к показанной ревизии; второе окно делает подтверждение недоступным. */
export async function confirmProject(
  context: CliContext,
  view: ProjectView,
  action: ProjectView['allowedActions'][number],
  message: string,
  body: string,
  active = 'Подтвердить',
): Promise<boolean> {
  const answer = await liveConfirm({
    title: view.title,
    message,
    body,
    active,
    inactive: 'Назад',
    load: async () => {
      const current = await context.request('projects.detail', { projectId: view.projectId });
      const available =
        current.revision === view.revision && current.allowedActions.includes(action);
      return {
        available,
        detail: available
          ? 'Показанная версия проекта'
          : 'Проект изменился · откройте карточку заново',
      };
    },
  });
  return answer === true;
}
