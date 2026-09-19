import type { CliContext, StatusView } from '../types.js';
import type { TaskDraft } from '../../sessions/drafts.js';
import { chooseDraft, draftLocation } from './task-drafts.js';
import { readTaskInput } from './task-input.js';
import { liveSelect } from './live-select.js';
import { readText } from './text-reader.js';
import { explainError } from './errors.js';
import { isMissingResource } from '../../shared/resource-errors.js';

/** Уточнение адресуется текущему запуску и не создаёт новый этап беседы. */
export function canMessageTask(
  status: Pick<StatusView, 'status' | 'deletedAt' | 'recoveryRequired' | 'project'>,
): boolean {
  return (
    !status.recoveryRequired &&
    !status.project &&
    !status.deletedAt &&
    ['running', 'awaiting_approval', 'paused'].includes(status.status)
  );
}

/** Объясняет момент доставки, не выдавая очередь за прочитанное моделью сообщение. */
function inputDescription(status: StatusView): string {
  if (!canMessageTask(status)) return 'Задача завершена · черновик остаётся';
  if (status.status === 'paused') return 'Сообщение ждёт продолжения задачи';
  if (status.status === 'awaiting_approval') return 'Сообщение ждёт решения о разрешении';
  return 'Модель получит сообщение на следующем шаге';
}

/** Показывает полный сохранённый текст без отправки и перехода к новому запуску. */
async function inspectMessage(context: CliContext, draft: TaskDraft): Promise<void> {
  await readText(
    'Сохранённое сообщение',
    [{ id: 'message', label: 'Текст', text: draft.text || 'Сообщение пустое.' }],
    {
      load: async () => {
        const current = await context.request('drafts.get', draftLocation(draft));
        return {
          tabs: [{ id: 'message', label: 'Текст', text: current.text || 'Сообщение пустое.' }],
          notice: 'Это сохранённый черновик сообщения.',
        };
      },
      exitOnError: (error) => isMissingResource(error, 'draft'),
    },
  );
}

/** Черновик и ключ остаются на диске до подтверждения; повтор не дублирует уточнение. */
export async function writeTaskMessage(context: CliContext, initial: StatusView): Promise<string> {
  let current = await context.request('runtime.status', { runId: initial.runId });
  const scope = {
    workspace: initial.workspace,
    profile: initial.profile,
    sessionId: initial.sessionId,
    messageRunId: initial.runId,
  };
  let draft: TaskDraft | undefined;
  try {
    draft = await chooseDraft(context, scope, {
      allowNew: canMessageTask(current),
      inspect: !canMessageTask(current),
    });
    if (!draft && !canMessageTask(current)) return 'Сохранённых сообщений нет.';
    draft ??= await context.request('drafts.create', { scope });
    while (true) {
      if (!canMessageTask(current) && draft.state === 'editing') {
        await inspectMessage(context, draft);
        return 'Сообщение осталось в «Черновиках сообщений».';
      }
      if (draft.state === 'editing') {
        const value = await readTaskInput({
          message: 'Написать модели',
          workspace: draft.scope.workspace,
          initialValue: draft.text,
          description: () => inputDescription(current),
          refresh: async () => {
            current = await context.request('runtime.status', { runId: initial.runId });
            return context.request('drafts.get', draftLocation(draft!));
          },
          save: async (text) => {
            if (text === draft!.text) return;
            draft = await context.request('drafts.update', {
              ...draftLocation(draft!),
              expectedRevision: draft!.revision,
              text,
            });
          },
        });
        if (typeof value === 'symbol') return 'Черновик сообщения сохранён.';
        current = await context.request('runtime.status', { runId: initial.runId });
        if (!canMessageTask(current)) {
          await inspectMessage(context, draft);
          return 'Задача завершилась. Сообщение осталось в черновиках.';
        }
        draft = await context.request('drafts.update', {
          ...draftLocation(draft),
          expectedRevision: draft.revision,
          state: 'pending',
        });
      }
      let accepted: { status: 'queued' | 'delivered' };
      try {
        accepted = await context.request('runtime.message', {
          runId: initial.runId,
          message: draft.text,
          requestKey: draft.requestKey,
        });
      } catch (error) {
        while (true) {
          const choice = await liveSelect({
            title: 'Сообщение не подтверждено',
            load: async () => ({
              summary: explainError(error) + '\n\nТекст и ключ повтора сохранены в черновике.',
              message: 'Что сделать?',
              options: [
                { value: 'retry', label: 'Повторить отправку' },
                { value: 'read', label: 'Прочитать сохранённый текст' },
                { value: 'back', label: 'Вернуться к задаче' },
              ],
            }),
          });
          if (choice === 'read') {
            await inspectMessage(context, draft);
            continue;
          }
          if (choice !== 'retry') return 'Сообщение сохранено. Отправка не подтверждена.';
          break;
        }
        continue;
      }
      try {
        await context.request('drafts.remove', {
          ...draftLocation(draft),
          expectedRevision: draft.revision,
        });
      } catch {
        return 'Сообщение принято; черновик ещё сохранён.';
      }
      return accepted.status === 'delivered'
        ? 'Сообщение добавлено в контекст модели.'
        : 'Сообщение принято и сохранено.';
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL')
      return 'Отправка отменена. Сохранённые черновики остались.';
    if (isMissingResource(error, 'draft')) return 'Черновик удалён в другом окне.';
    throw error;
  }
}
