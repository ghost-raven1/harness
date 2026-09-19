import { SessionChangedError } from '../../shared/session-conflict.js';
import type { CliContext } from '../types.js';
import type { TaskDraft } from '../../sessions/drafts.js';
import { draftLocation } from './task-drafts.js';
import { liveConfirm } from './live-confirm.js';
import { selected } from '../ui.js';

/** Только известный отказ без принятия задачи позволяет предложить перенос сохранённого текста. */
export async function rebaseDraft(
  context: CliContext,
  draft: TaskDraft,
  error: SessionChangedError,
): Promise<TaskDraft> {
  const latest = await context.request('runtime.status', { runId: error.latestRunId });
  const yes = selected(
    (await liveConfirm({
      title: 'В беседе появился новый ответ',
      message: 'Продолжить с последним ответом?',
      body:
        (latest.result ?? latest.task ?? latest.runId) +
        '\n\nВаш текст сохранён. После подтверждения его можно изменить перед отправкой.',
      active: 'Продолжить с последним ответом',
      inactive: 'Вернуться позже',
      load: async () => {
        const current = await context.request('runtime.status', {
          runId: latest.runId,
        });
        return {
          available:
            !current.deletedAt && ['completed', 'failed', 'cancelled'].includes(current.status),
          detail: current.deletedAt
            ? 'Задача удалена'
            : current.status === 'running'
              ? 'Новый этап ещё выполняется'
              : 'Сохранённый текст будет перенесён',
        };
      },
    })) ?? false,
  );
  if (!yes) throw new Error('INTERACTIVE_CANCEL');
  return context.request('drafts.rebase', {
    ...draftLocation(draft),
    expectedRevision: draft.revision,
    parentRunId: latest.runId,
  });
}
