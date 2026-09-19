import type { DraftScope, TaskDraft } from '../../../sessions/drafts.js';
import type { ProjectView } from '../../../projects/types.js';
import type { CliContext } from '../../types.js';
import { chooseDraft, draftLocation } from '../task-drafts.js';
import { readTaskInput } from '../task-input.js';
import { selected } from '../../ui.js';
import { applicationErrorData } from '../../../shared/application-error.js';
import { liveSelect } from '../live-select.js';
import { explainError } from '../errors.js';

/** Сохраняет ввод и реквизиты отправки; повтор после обрыва использует прежнюю ревизию. */
export async function projectDraft(
  context: CliContext,
  scope: DraftScope,
  message: string,
  view?: ProjectView,
  limit = 32000,
): Promise<TaskDraft> {
  let draft =
    (await chooseDraft(context, scope)) ?? (await context.request('drafts.create', { scope }));
  if (draft.state === 'pending') return draft;
  const text = selected(
    await readTaskInput({
      message,
      initialValue: draft.text,
      workspace: scope.workspace,
      description: () => 'Опишите своими словами. Ctrl+S — отправить, Esc — сохранить и вернуться.',
      save: async (text) => {
        if (text.length > limit)
          throw new Error(`Сократите сообщение до ${limit.toLocaleString('ru-RU')} символов.`);
        draft = await context.request('drafts.update', {
          ...draftLocation(draft),
          expectedRevision: draft.revision,
          text,
        });
      },
      refresh: async () => context.request('drafts.get', draftLocation(draft)),
    }),
  );
  if (text.length > limit) throw new Error('Сообщение слишком длинное. Черновик сохранён.');
  return context.request('drafts.update', {
    ...draftLocation(draft),
    expectedRevision: draft.revision,
    text,
    state: 'pending',
    expectedProjectRevision: view?.revision,
  });
}

/** Удаляет только подтверждённый черновик; ошибка связи оставляет возможность безопасного повтора. */
export async function finishProjectDraft(context: CliContext, draft: TaskDraft): Promise<void> {
  await context.request('drafts.remove', {
    ...draftLocation(draft),
    expectedRevision: draft.revision,
  });
}

/** Отказ не меняет ключ автоматически: намерение могло сохраниться до ошибки доставки. */
export async function submitProjectDraft<T>(
  context: CliContext,
  draft: TaskDraft,
  send: () => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await send();
  } catch (error) {
    const code = applicationErrorData(error)?.code;
    if (code === 'PROJECT_CONFLICT' || code === 'INVALID_PLAN') {
      const choice = await liveSelect({
        title: 'Отправка требует проверки',
        load: async () => {
          const view = draft.scope.projectId
            ? await context.request('projects.detail', { projectId: draft.scope.projectId })
            : undefined;
          return {
            summary:
              explainError(error) +
              '\nЗапрос мог сохраниться до ошибки доставки. Проверьте журнал проекта перед повторным действием.',
            message: 'Как поступить с текстом?',
            options: [
              { value: 'back', label: 'Сохранить прежний запрос и вернуться' },
              ...(view
                ? [
                    {
                      value: 'copy',
                      label: 'Создать отдельный черновик',
                      hint: 'отправить его можно будет после редактирования',
                    },
                  ]
                : []),
            ],
          };
        },
      });
      if (choice === 'copy')
        await context.request('drafts.create', { scope: draft.scope, text: draft.text });
    }
    throw error;
  }
  await finishProjectDraft(context, draft);
  return result;
}
