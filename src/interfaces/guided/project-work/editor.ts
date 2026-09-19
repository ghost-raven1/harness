import type { ProjectPlan, ProjectView } from '../../../projects/types.js';
import type { TaskDraft } from '../../../sessions/drafts.js';
import { applicationErrorData } from '../../../shared/application-error.js';
import { resolveEditorConflict } from './editor-conflict.js';
import type { CliContext } from '../../types.js';
import { chooseDraft, draftLocation } from '../task-drafts.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { liveConfirm } from '../live-confirm.js';
import { projectField, projectChoice } from './form-input.js';
import { editStage, freshStage } from './stage-editor.js';
import { comparisonText } from './plan-history.js';
import { finishProjectDraft } from './drafts.js';

/** Редактор сохраняет поля в черновике; весь план публикуется одной проверенной версией. */
export async function editProjectPlan(
  context: CliContext,
  view: ProjectView,
  restoredDraft?: TaskDraft,
): Promise<void> {
  if (!view.plan) return;
  const { version: _version, ...initial } = view.plan;
  const scope = {
    workspace: view.workspace,
    profile: view.profile,
    projectId: view.projectId,
    purpose: 'project.edit' as const,
  };
  let draft =
    restoredDraft ??
    (await chooseDraft(context, scope)) ??
    (await context.request('drafts.create', {
      scope,
      text: view.title,
      payload: { kind: 'project.edit', plan: initial },
      expectedProjectRevision: view.revision,
    }));
  if (draft.payload?.kind !== 'project.edit') throw new Error('Черновик редактора недоступен.');
  let plan: ProjectPlan = draft.payload.plan;
  const update = async (next: ProjectPlan): Promise<void> => {
    draft = await context.request('drafts.update', {
      ...draftLocation(draft),
      expectedRevision: draft.revision,
      payload: { kind: 'project.edit', plan: next },
    });
    plan = next;
  };
  const completed = new Set(
    view.stages.filter((stage) => stage.status === 'completed').map((stage) => stage.stageId),
  );
  const send = async (): Promise<void> => {
    if (draft.payload?.kind !== 'project.edit') return;
    try {
      await context.request('projects.editPlan', {
        projectId: view.projectId,
        expectedRevision: draft.expectedProjectRevision ?? view.revision,
        requestKey: draft.requestKey,
        plan: draft.payload.plan,
      });
      await finishProjectDraft(context, draft);
    } catch (error) {
      const code = applicationErrorData(error)?.code;
      if (code !== 'PROJECT_CONFLICT' && code !== 'INVALID_PLAN') throw error;
      const next = await resolveEditorConflict(context, draft);
      if (next) await editProjectPlan(context, next.view, next.draft);
    }
  };
  if (draft.state === 'pending') {
    await send();
    return;
  }
  let notice = '';
  while (true) {
    let stale = false;
    const choice = await liveSelect({
      title: 'Редактор плана',
      load: async () => {
        const current = await context.request('projects.detail', { projectId: view.projectId });
        stale = current.revision !== (draft.expectedProjectRevision ?? view.revision);
        return {
          summary: stale
            ? 'Проект изменён в другом окне. Ваш ввод сохранён. Сравните его с актуальным планом; отправка этой редакции заблокирована.'
            : `Черновик · ${plan.stages.length} этапов\n${notice}`,
          message: 'Измените план без запуска исполнителей',
          options: [
            ...plan.stages.map((stage, index) => ({
              value: `stage:${stage.id}`,
              label: `${index + 1}. ${stage.title || 'Без названия'}`,
              hint: completed.has(stage.id) ? 'завершён · только чтение' : 'редактировать',
            })),
            ...(plan.stages.length < 32
              ? [
                  { value: 'add', label: 'Добавить этап' },
                  ...(plan.stages.length ? [{ value: 'copy', label: 'Копировать этап' }] : []),
                ]
              : []),
            ...(plan.stages.some((stage) => !completed.has(stage.id))
              ? [
                  { value: 'delete', label: 'Удалить незавершённый этап' },
                  ...(plan.stages.some((stage, index) => index > 0 && !completed.has(stage.id))
                    ? [{ value: 'move', label: 'Изменить порядок этапов' }]
                    : []),
                ]
              : []),
            {
              value: 'corrections',
              label: 'Предел исправлений',
              hint: String(plan.maxCorrections),
            },
            {
              value: 'baseline',
              label: 'Исправлять исходные ошибки',
              hint: plan.fixBaselineFailures ? 'да' : 'нет',
            },
            { value: 'compare', label: 'Сравнить с актуальным планом' },
            { value: 'validate', label: 'Проверить черновик' },
            ...(!stale && current.allowedActions.includes('editPlan')
              ? [{ value: 'save', label: 'Сохранить новую версию плана' }]
              : []),
            { value: 'back', label: 'Оставить черновик и вернуться' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice.startsWith('stage:')) {
      const stage = plan.stages.find((item) => item.id === choice.slice(6));
      if (stage)
        await editStage(
          view,
          stage,
          () => plan,
          async (next) =>
            update({
              ...plan,
              stages: plan.stages.map((item) => (item.id === next.id ? next : item)),
            }),
        );
    }
    if (choice === 'add') await update({ ...plan, stages: [...plan.stages, freshStage(view)] });
    if (choice === 'copy')
      await projectChoice(
        'Какой этап скопировать?',
        plan.stages.map((stage) => ({ value: stage.id, label: stage.title })),
        async (stageId) =>
          update({
            ...plan,
            stages: [
              ...plan.stages,
              freshStage(
                view,
                plan.stages.find((stage) => stage.id === stageId),
              ),
            ],
          }),
      );
    if (choice === 'delete')
      await projectChoice(
        'Какой этап удалить?',
        plan.stages
          .filter((stage) => !completed.has(stage.id))
          .map((stage) => ({ value: stage.id, label: stage.title })),
        async (stageId) =>
          update({ ...plan, stages: plan.stages.filter((stage) => stage.id !== stageId) }),
      );
    if (choice === 'move')
      await projectChoice(
        'Какой этап переместить на одну позицию выше?',
        plan.stages
          .filter((stage, index) => index > 0 && !completed.has(stage.id))
          .map((stage) => ({ value: stage.id, label: stage.title })),
        async (stageId) => {
          const stages = [...plan.stages],
            index = stages.findIndex((stage) => stage.id === stageId);
          if (index > 0) {
            [stages[index - 1], stages[index]] = [stages[index]!, stages[index - 1]!];
            await update({ ...plan, stages });
          }
        },
      );
    if (choice === 'corrections')
      await projectField(
        'Предел исправлений от 0 до 10',
        String(plan.maxCorrections),
        async (value) => {
          if (!/^\d+$/.test(value) || Number(value) > 10)
            throw new Error('Введите целое число от 0 до 10.');
          await update({ ...plan, maxCorrections: Number(value) });
        },
      );
    if (choice === 'baseline')
      await update({ ...plan, fixBaselineFailures: !plan.fixBaselineFailures });
    if (choice === 'compare') {
      const current = await context.request('projects.detail', { projectId: view.projectId });
      const result = await context.request('projects.comparePlans', {
        projectId: view.projectId,
        fromVersion: current.planVersion,
        plan,
      });
      await readText('Сравнение · ввод сохранён', [
        { id: 'diff', label: 'Изменения', text: comparisonText(result) },
      ]);
    }
    if (choice === 'validate' || choice === 'save') {
      const validation = await context.request('projects.validatePlan', {
        projectId: view.projectId,
        expectedRevision: draft.expectedProjectRevision ?? view.revision,
        plan,
      });
      if (!validation.valid || validation.stale || !validation.plan) {
        notice = validation.stale
          ? 'Проект изменился. Сравните редакции.'
          : 'Исправьте отмеченные поля.';
        await readText('Проверка черновика', [
          {
            id: 'issues',
            label: 'Замечания',
            text: [
              notice,
              ...validation.issues.map(
                (issue) => `${planFieldLabel(issue.path, plan)} · ${issue.message}`,
              ),
            ].join('\n'),
          },
        ]);
        continue;
      }
      if (choice === 'validate') {
        notice = 'Проверка пройдена. Команды не выполнялись.';
        continue;
      }
      const confirmed = await liveConfirm({
        title: 'Сохранение плана',
        message: 'Создать одну новую версию?',
        active: 'Сохранить',
        inactive: 'Назад',
        body: 'Изменения не запускают проект. Перед выполнением потребуется принять новую версию.',
        load: async () => {
          const current = await context.request('projects.detail', { projectId: view.projectId });
          return {
            available:
              current.revision === validation.revision &&
              current.allowedActions.includes('editPlan'),
            detail:
              current.revision === validation.revision
                ? 'Редакция проверена'
                : 'Проект изменён в другом окне',
          };
        },
      });
      if (confirmed !== true) continue;
      draft = await context.request('drafts.update', {
        ...draftLocation(draft),
        expectedRevision: draft.revision,
        payload: { kind: 'project.edit', plan: validation.plan },
        state: 'pending',
      });
      await send();
      return;
    }
  }
}

/** Переводит путь валидатора в название поля формы, сохраняя номер этапа и аргумента. */
function planFieldLabel(path: Array<string | number>, plan: ProjectPlan): string {
  const labels: Record<string, string> = {
    title: 'Название',
    task: 'Задача',
    role: 'Специалист',
    dependsOn: 'Зависимости',
    expectedResult: 'Ожидаемый результат',
    requiredTools: 'Инструменты',
    verification: 'Проверка',
    command: 'Программа',
    args: 'Аргументы',
    instructions: 'Ручная проверка',
    maxCorrections: 'Предел исправлений',
    fixBaselineFailures: 'Исходные ошибки',
    stages: 'Этапы',
    checks: 'Команды',
  };
  return (
    path
      .map((part, index) => {
        if (typeof part === 'number') {
          if (path[index - 1] === 'stages')
            return `${part + 1} «${plan.stages[part]?.title ?? 'Без названия'}»`;
          return String(part + 1);
        }
        return labels[part] ?? part;
      })
      .join(' → ') || 'План'
  );
}
