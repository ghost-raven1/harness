import type { ProjectView } from '../../../projects/types.js';
import { isMissingResource } from '../../../shared/resource-errors.js';
import { message } from '../../../shared/primitives.js';
import type { CliContext } from '../../types.js';
import { readText } from '../text-reader.js';
import { liveSelect } from '../live-select.js';
import { explainError } from '../errors.js';
import { projectSummary, projectTabs } from './format.js';
import { projectAction } from './actions.js';

const labels: Record<ProjectView['allowedActions'][number], string> = {
  plan: 'Предложить план',
  editPlan: 'Предел исправлений',
  acceptPlan: 'Принять план и начать',
  pause: 'Приостановить',
  resume: 'Продолжить',
  cancel: 'Остановить проект',
  message: 'Уточнить работающему этапу',
  manualCheck: 'Проверить результат вручную',
  recheck: 'Повторить проверку результата',
  accept: 'Принять результат',
  archive: 'Убрать в архив',
  purge: 'Удалить навсегда',
  resolve: 'Проверить прерванную операцию',
};

/** Ограниченный журнал обновляется по курсору и не перечитывает все переписки проекта. */
export function projectReader(context: CliContext, projectId: string) {
  let cursor = 0;
  let events: ProjectView['events']['items'] = [];
  return async (): Promise<ProjectView> => {
    const view = await context.request('projects.detail', { projectId, cursor, eventLimit: 100 });
    const known = new Set(events.map((event) => event.seq));
    events = [...events, ...view.events.items.filter((event) => !known.has(event.seq))].slice(-200);
    cursor = view.events.cursor;
    return { ...view, events: { ...view.events, items: events } };
  };
}

/** Полный проект и меню действий остаются живыми при работе второго окна. */
export async function inspectProject(context: CliContext, projectId: string): Promise<void> {
  const load = projectReader(context, projectId);
  let notice = '';
  let view = await load();
  const missing = (error: unknown) => isMissingResource(error, 'project');
  while (true) {
    try {
      const result = await readText('Проект · ' + view.title, projectTabs(view), {
        subtitle: projectSummary(view),
        actionLabel: 'Действия',
        exitOnError: missing,
        load: async () => {
          view = await load();
          return {
            tabs: projectTabs(view),
            subtitle: projectSummary(view),
            actionLabel: 'Действия',
            notice,
          };
        },
      });
      if (result === 'back') return;
      let showReader = false;
      while (!showReader) {
        const action = await liveSelect({
          title: view.title,
          exitOnError: missing,
          load: async () => {
            view = await load();
            return {
              summary: [projectSummary(view), view.reason, notice].filter(Boolean).join('\n'),
              message: 'Что дальше?',
              options: [
                { value: 'read', label: 'Цель, план, проверки и журнал' },
                ...((view.pendingApprovals ?? 0) > 0
                  ? [{ value: 'approvals', label: 'Рассмотреть разрешения' }]
                  : []),
                ...view.allowedActions.map((value) => ({
                  value,
                  label:
                    value === 'plan' && view.plan
                      ? 'Попросить изменить план'
                      : value === 'archive' && view.archivedAt
                        ? 'Вернуть из архива'
                        : labels[value],
                })),
                ...(view.reasonCode === 'BASELINE_FAILED' &&
                view.allowedActions.includes('editPlan')
                  ? [{ value: 'baseline', label: 'Включить исправление исходных ошибок в план' }]
                  : []),
                ...(view.currentRunId || view.stages.some((stage) => stage.runId)
                  ? [{ value: 'logs', label: 'Журнал, мысли и ответ этапа' }]
                  : []),
                { value: 'back', label: '← К списку проектов' },
              ],
            };
          },
        });
        if (typeof action === 'symbol' || action === 'back') return;
        if (action === 'read') {
          showReader = true;
          continue;
        }
        notice = '';
        try {
          if (await projectAction(context, view, action)) return;
        } catch (error) {
          if (missing(error)) throw error;
          if (message(error) !== 'INTERACTIVE_CANCEL') notice = explainError(error);
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
      await readText('Проект удалён', [
        {
          id: 'removed',
          label: 'Проект',
          text: 'Проект удалён в другом окне. Esc — к списку проектов.',
        },
      ]);
      return;
    }
  }
}
