import * as prompts from '@clack/prompts';
import type { CliContext, StatusView } from '../types.js';
import type { DraftScope, TaskDraft } from '../../sessions/drafts.js';
import { taskTextLimit } from '../../sessions/drafts.js';
import { readTaskInput } from './task-input.js';
import { chooseDraft, draftLocation, pendingDraft } from './task-drafts.js';
import { liveSelect } from './live-select.js';
import { selected } from '../ui.js';
import { explainError } from './errors.js';
import { SessionChangedError } from '../../shared/session-conflict.js';
import { rebaseDraft } from './rebase-draft.js';

export interface NewTaskInput {
  scope: DraftScope;
  title?: string;
  initialValue?: string;
  text?: string;
  requestKey?: string;
  previous?: StatusView;
}

/** Сначала сохраняет ввод и ключ, затем отправляет запрос; удаляет черновик после подтверждения. */
export async function prepareTask(
  context: CliContext,
  input: NewTaskInput,
): Promise<{ runId: string; sessionId: string }> {
  if (input.text !== undefined && (!input.text.trim() || input.text.length > taskTextLimit))
    throw new Error('Задача должна содержать от 1 до 100 000 символов и не состоять из пробелов.');
  let draft =
    input.text === undefined
      ? await chooseDraft(context, input.scope)
      : await pendingDraft(context, input.scope, input.text, input.requestKey);
  draft ??= await context.request<TaskDraft>('drafts.create', {
    scope: input.scope,
    text: input.text ?? input.initialValue ?? '',
    requestKey: input.requestKey,
  });
  while (true) {
    if (draft.state === 'editing') {
      if (input.text === undefined) {
        const value = await readTaskInput({
          message: input.title ?? 'Что нужно сделать?',
          initialValue: draft.text,
          workspace: draft.scope.workspace,
          refresh: () => context.request('drafts.get', draftLocation(draft!)),
          save: async (text) => {
            if (text === draft!.text) return;
            draft = await context.request<TaskDraft>('drafts.update', {
              ...draftLocation(draft!),
              expectedRevision: draft!.revision,
              text,
            });
          },
        });
        if (typeof value === 'symbol') throw new Error('INTERACTIVE_CANCEL');
      }
      if (input.previous) {
        const current = await context.request<StatusView>('runtime.status', {
          runId: input.previous.runId,
        });
        if (current.unknownInvocations.length)
          throw new Error(
            'Сначала выберите «Проверить прерванную операцию» и установите её результат. Черновик сохранён.',
          );
        if (
          current.deletedAt ||
          ['running', 'awaiting_approval', 'paused'].includes(current.status)
        )
          throw new Error(
            'Состояние задачи изменилось. Вернитесь к списку и выберите доступное действие. Черновик сохранён.',
          );
      }
      draft = await context.request<TaskDraft>('drafts.update', {
        ...draftLocation(draft),
        expectedRevision: draft.revision,
        state: 'pending',
      });
    }
    let result: { runId: string; sessionId: string };
    try {
      result = await context.request('runtime.run', {
        ...draft.scope,
        message: draft.text,
        requestKey: draft.requestKey,
      });
    } catch (error) {
      if (context.interactive() && error instanceof SessionChangedError) {
        draft = await rebaseDraft(context, draft, error);
        input = { ...input, text: undefined, previous: undefined };
        continue;
      }
      if (!context.interactive())
        throw new Error(
          'Отправка не подтверждена. Черновик и ключ сохранены; повторите ту же команду. ' +
            explainError(error),
          { cause: error },
        );
      const choice = selected(
        await liveSelect({
          title: 'Запрос не подтверждён',
          load: async () => ({
            summary:
              explainError(error) +
              '\n\nСообщение сохранено. Повторная отправка использует прежний ключ и найдёт уже принятую задачу.',
            message: 'Что сделать?',
            options: [
              { value: 'retry', label: 'Повторить отправку' },
              { value: 'back', label: 'Вернуться позже' },
            ],
          }),
        }),
      );
      if (choice === 'back') throw new Error('INTERACTIVE_CANCEL');
      continue;
    }
    try {
      await context.request('drafts.remove', {
        ...draftLocation(draft),
        expectedRevision: draft.revision,
      });
    } catch {
      if (context.interactive())
        prompts.log.warn(
          'Задача принята, но черновик ещё не удалён. «Проверить отправку» откроет эту же задачу.',
        );
    }
    return result;
  }
}
