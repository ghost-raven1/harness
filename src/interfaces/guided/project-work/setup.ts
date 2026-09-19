import { hash } from '../../../shared/primitives.js';
import type { TaskDraft } from '../../../sessions/drafts.js';
import type { CliContext } from '../../types.js';
import type { Preferences } from '../preferences.js';
import { chooseDraft, draftLocation } from '../task-drafts.js';
import { liveSelect } from '../live-select.js';
import { liveConfirm } from '../live-confirm.js';
import { projectChoice, projectField } from './form-input.js';
import { finishProjectDraft } from './drafts.js';
import { inspectProject } from './detail.js';

type Creation = {
  kind: 'project.create';
  title: string;
  goal: string;
  workspace: string;
  profile: string;
};

/** Подготовка хранит параметры отдельно от глобальных предпочтений и не вызывает модель до подтверждения. */
export async function prepareProject(context: CliContext, preferences: Preferences): Promise<void> {
  const scope = {
    workspace: preferences.workspace,
    profile: preferences.profile,
    purpose: 'project.create' as const,
  };
  let draft =
    (await chooseDraft(context, scope)) ??
    (await context.request('drafts.create', {
      scope,
      payload: {
        kind: 'project.create',
        title: '',
        goal: '',
        workspace: preferences.workspace,
        profile: preferences.profile,
      },
    }));
  let payload = draft.payload as Creation;
  if (!payload || payload.kind !== 'project.create')
    throw new Error('Черновик параметров проекта недоступен.');
  const update = async (next: Creation): Promise<void> => {
    draft = await context.request('drafts.update', {
      ...draftLocation(draft),
      expectedRevision: draft.revision,
      text: next.goal,
      payload: next,
    });
    payload = next;
  };
  const goal = async () => {
    const useGoalAsTitle = !payload.title;
    await projectField(
      'Какого результата вы хотите добиться?',
      payload.goal,
      async (value) => update({ ...payload, goal: value }),
      { refresh: async () => context.request('drafts.get', draftLocation(draft)) },
    );
    if (useGoalAsTitle && payload.goal.trim())
      await update({ ...payload, title: payload.goal.trim().split('\n')[0]!.slice(0, 500) });
  };
  if (draft.state !== 'pending' && !payload.goal) await goal();
  while (draft.state !== 'pending') {
    const choice = await liveSelect({
      title: 'Новый проект · перед планированием',
      load: async () => ({
        summary: `Название: ${payload.title || 'Не задано'}\nПапка: ${payload.workspace}\nПрофиль: ${payload.profile}\nЦель: ${payload.goal || 'Не задана'}`,
        message: 'Проверьте параметры',
        options: [
          {
            value: 'submit',
            label: 'Подготовить план',
            hint: 'исследовать папку без изменения файлов',
          },
          { value: 'goal', label: 'Изменить цель' },
          { value: 'title', label: 'Изменить название' },
          { value: 'workspace', label: 'Выбрать папку' },
          { value: 'profile', label: 'Выбрать модель' },
          { value: 'back', label: 'Сохранить черновик и вернуться' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'goal') await goal();
    if (choice === 'title')
      await projectField(
        'Название проекта',
        payload.title,
        async (title) => update({ ...payload, title }),
        { limit: 500 },
      );
    if (choice === 'workspace') {
      const info = await context.request('system.info');
      await projectChoice(
        'Папка проекта · разрешённые настройки',
        [...new Set([payload.workspace, ...info.workspaces])].map((workspace) => ({
          value: workspace,
          label: workspace,
        })),
        async (workspace) => update({ ...payload, workspace }),
      );
    }
    if (choice === 'profile') {
      const info = await context.request('system.info');
      await projectChoice(
        'Модель для этого проекта',
        info.profiles.map((profile) => ({
          value: profile.id,
          label: `${profile.id} · ${profile.model}`,
        })),
        async (profile) => update({ ...payload, profile }),
      );
    }
    if (choice === 'submit') {
      if (!payload.title.trim() || !payload.goal.trim()) {
        await goal();
        continue;
      }
      const confirmed = await liveConfirm({
        title: 'Подготовить план',
        message: 'Передать эту цель модели?',
        active: 'Подготовить',
        inactive: 'Изменить параметры',
        body: `${payload.title}\n${payload.goal}\n\nПапка: ${payload.workspace}\nМодель: ${payload.profile}\nФайлы будут доступны только для исследования. Исполнение потребует принятия плана.`,
        load: async () => {
          const current = await context.request('drafts.get', draftLocation(draft));
          return {
            available: current.revision === draft.revision,
            detail:
              current.revision === draft.revision
                ? 'Параметры сохранены'
                : 'Черновик изменён в другом окне',
          };
        },
      });
      if (confirmed !== true) continue;
      draft = await context.request('drafts.update', {
        ...draftLocation(draft),
        expectedRevision: draft.revision,
        state: 'pending',
        payload,
      });
    }
  }
  await sendProjectCreation(context, draft);
}

/** Неизменный черновик повторяет создание и подготовку с прежними ключами после потери ответа. */
export async function sendProjectCreation(context: CliContext, draft: TaskDraft): Promise<void> {
  const payload = draft.payload;
  if (payload?.kind !== 'project.create' || draft.state !== 'pending')
    throw new Error('Сначала подтвердите параметры проекта.');
  let view = await context.request('projects.create', {
    title: payload.title,
    goal: payload.goal,
    workspace: payload.workspace,
    profile: payload.profile,
    requestKey: draft.requestKey,
  });
  if (view.status === 'draft')
    view = await context.request('projects.plan', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey:
        draft.requestKey.length <= 195
          ? draft.requestKey + ':plan'
          : 'plan:' + hash(draft.requestKey),
    });
  await finishProjectDraft(context, draft);
  await inspectProject(context, view.projectId, true);
}
