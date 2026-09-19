import * as prompts from '@clack/prompts';
import type { CliContext } from '../../types.js';
import type { Preferences } from '../preferences.js';
import { id, message } from '../../../shared/primitives.js';
import { isMissingResource } from '../../../shared/resource-errors.js';
import { selected } from '../../ui.js';
import { liveSelect } from '../live-select.js';
import { page } from '../screen.js';
import { explainError } from '../errors.js';
import { projectDraft, finishProjectDraft } from './drafts.js';
import { inspectProject } from './detail.js';
import { projectStatusLabels } from './format.js';

/** Сохраняет цель до запроса к модели; действия начнутся только после принятия плана. */
async function createProject(context: CliContext, preferences: Preferences): Promise<void> {
  const draft = await projectDraft(
    context,
    { workspace: preferences.workspace, profile: preferences.profile, purpose: 'project.goal' },
    'Какого результата вы хотите добиться?',
  );
  const title = draft.text.trim().split('\n')[0]!.slice(0, 500);
  let view = await context.request('projects.create', {
    title,
    goal: draft.text,
    workspace: preferences.workspace,
    profile: preferences.profile,
    requestKey: draft.requestKey,
  });
  await finishProjectDraft(context, draft);
  if (view.status === 'draft')
    view = await context.request('projects.plan', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: id(),
    });
  await inspectProject(context, view.projectId);
}

/** Список обновляет состояния и сохраняет выбор, когда проекты меняются в другом окне. */
export async function browseProjects(context: CliContext, preferences: Preferences): Promise<void> {
  let pageIndex = 0,
    query = '',
    archived = false,
    notice = '';
  while (true) {
    const choice = await liveSelect({
      title: archived ? 'Проекты и архив' : 'Проекты',
      load: async () => {
        const [info, list] = await Promise.all([
          context.request('system.info'),
          context.request('projects.list', { page: pageIndex, query, includeArchived: archived }),
        ]);
        pageIndex = list.page;
        return {
          summaryTitle: 'От цели до проверенного результата',
          summary: [
            notice,
            list.total
              ? `Проектов: ${list.total}`
              : 'Создайте проект: опишите цель, просмотрите план и подтвердите выполнение.',
            query ? 'Поиск: ' + query : '',
          ]
            .filter(Boolean)
            .join('\n'),
          message: `Проекты · ${list.page + 1} / ${list.pages}`,
          options: [
            ...(!info.recoveryError
              ? [{ value: 'create', label: 'Новый проект', hint: 'цель, план и этапы' }]
              : []),
            ...list.items.map((item) => ({
              value: 'open:' + item.projectId,
              label: item.title,
              hint: projectStatusLabels[item.status] + (item.archivedAt ? ' · архив' : ''),
            })),
            { value: 'search', label: 'Найти проект' },
            ...(query ? [{ value: 'clear', label: 'Сбросить поиск' }] : []),
            ...(list.page + 1 < list.pages
              ? [{ value: 'next', label: 'Следующая страница →' }]
              : []),
            ...(list.page > 0 ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
            { value: 'archive', label: archived ? 'Скрыть архив' : 'Показать архив' },
            { value: 'back', label: '← В главное меню' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    notice = '';
    try {
      if (choice === 'create') await createProject(context, preferences);
      if (choice.startsWith('open:')) await inspectProject(context, choice.slice(5));
      if (choice === 'next') pageIndex++;
      if (choice === 'previous') pageIndex = Math.max(0, pageIndex - 1);
      if (choice === 'archive') {
        archived = !archived;
        pageIndex = 0;
      }
      if (choice === 'clear') {
        query = '';
        pageIndex = 0;
      }
      if (choice === 'search') {
        page('Поиск проекта');
        query = selected(
          await prompts.text({
            message: 'Название или текст цели',
            initialValue: query,
            validate: (value) => (value.length <= 200 ? undefined : 'До 200 символов.'),
          }),
        );
        pageIndex = 0;
      }
    } catch (error) {
      if (isMissingResource(error, 'project')) notice = 'Проект удалён в другом окне.';
      else if (message(error) !== 'INTERACTIVE_CANCEL') notice = explainError(error);
    }
  }
}
