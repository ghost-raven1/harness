import type { TaskDraft } from '../../../sessions/drafts.js';
import type { ProjectView } from '../../../projects/types.js';
import type { CliContext } from '../../types.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { comparisonText } from './plan-history.js';

/** После подтверждённого отказа пользователь сравнивает прежний запрос и явно создаёт новый черновик. */
export async function resolveEditorConflict(
  context: CliContext,
  draft: TaskDraft,
): Promise<{ draft: TaskDraft; view: ProjectView } | undefined> {
  if (draft.payload?.kind !== 'project.edit' || !draft.scope.projectId) return;
  const projectId = draft.scope.projectId,
    payload = draft.payload;
  while (true) {
    let current!: ProjectView;
    const choice = await liveSelect({
      title: 'План изменён в другом окне',
      load: async () => {
        current = await context.request('projects.detail', { projectId });
        return {
          summary: 'Прежний запрос и весь ввод сохранены. Автоматического объединения нет.',
          message: 'Как продолжить?',
          options: [
            { value: 'compare', label: 'Сравнить мой ввод с актуальным планом' },
            ...(current.allowedActions.includes('editPlan')
              ? [{ value: 'copy', label: 'Создать отдельный черновик для правок' }]
              : []),
            { value: 'back', label: 'Оставить прежний запрос и вернуться' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'compare') {
      const comparison = await context.request('projects.comparePlans', {
        projectId,
        fromVersion: current.planVersion,
        plan: payload.plan,
      });
      await readText('Сравнение сохранённого ввода', [
        { id: 'diff', label: 'Изменения', text: comparisonText(comparison) },
      ]);
    }
    if (choice === 'copy') {
      current = await context.request('projects.detail', { projectId });
      const copy = await context.request('drafts.create', {
        scope: draft.scope,
        text: draft.text,
        payload,
        expectedProjectRevision: current.revision,
      });
      return { draft: copy, view: current };
    }
  }
}
