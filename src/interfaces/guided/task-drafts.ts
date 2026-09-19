import type { CliContext } from '../types.js';
import type { DraftScope, TaskDraft } from '../../sessions/drafts.js';
import { liveSelect } from './live-select.js';
import { liveConfirm } from './live-confirm.js';
import { selected } from '../ui.js';
import { terminalText } from './screen.js';
import { isMissingResource } from '../../shared/resource-errors.js';

/** Адресует запись внутри беседы, не передавая текст и ключ повторной отправки. */
export const draftLocation = (draft: TaskDraft) => ({
  id: draft.id,
  sessionId: draft.scope.sessionId,
});

/** Восстановление явно показывает сохранённые сообщения; разные окна создают разные записи. */
export async function chooseDraft(
  context: CliContext,
  scope: DraftScope,
  options: { allowNew?: boolean; inspect?: boolean } = {},
): Promise<TaskDraft | undefined> {
  let offset = 0;
  while (true) {
    const load = async () => {
      let page = await context.request('drafts.list', {
        scope,
        offset,
      });
      const last = Math.max(0, Math.ceil(page.total / 20) - 1) * 20;
      if (offset > last) {
        offset = last;
        page = await context.request('drafts.list', { scope, offset });
      }
      return page;
    };
    if ((await load()).total === 0) return undefined;
    const choice = selected(
      await liveSelect({
        title: 'Сохранённые черновики',
        load: async () => {
          const page = await load();
          return {
            message: options.inspect
              ? 'Выберите сохранённое сообщение'
              : 'Продолжить сообщение или начать новое?',
            options: [
              ...page.items.map((item) => ({
                value: item.id,
                label: item.preview || 'Пустой черновик',
                hint: item.state === 'pending' ? 'отправка не подтверждена' : 'не отправлен',
              })),
              ...(options.allowNew === false ? [] : [{ value: 'new', label: 'Новое сообщение' }]),
              ...(offset + page.items.length < page.total
                ? [{ value: 'next', label: 'Следующие черновики →' }]
                : []),
              ...(offset > 0 ? [{ value: 'previous', label: '← Предыдущие черновики' }] : []),
              { value: 'back', label: '← Назад' },
            ],
          };
        },
      }),
    );
    if (choice === 'new') return undefined;
    if (choice === 'back') throw new Error('INTERACTIVE_CANCEL');
    if (choice === 'next' || choice === 'previous') {
      offset += choice === 'next' ? 20 : -20;
      continue;
    }
    const location = { id: choice, sessionId: scope.sessionId };
    try {
      let draft = await context.request('drafts.get', location);
      const action = selected(
        await liveSelect({
          title: scope.messageRunId ? 'Черновик сообщения' : 'Черновик задачи',
          exitOnError: (error) => isMissingResource(error, 'draft'),
          load: async () => {
            draft = await context.request('drafts.get', location);
            return {
              summary: terminalText(draft.text).slice(0, 500) || 'Сообщение пока пустое.',
              summaryTitle:
                draft.state === 'pending'
                  ? 'Сервис мог уже принять этот запрос'
                  : 'Сообщение не отправлено',
              message: 'Что сделать с черновиком?',
              options: [
                {
                  value: 'restore',
                  label:
                    options.inspect && draft.state !== 'pending'
                      ? 'Прочитать полный текст'
                      : draft.state === 'pending'
                        ? 'Проверить отправку'
                        : 'Продолжить ввод',
                },
                { value: 'delete', label: 'Удалить черновик' },
                { value: 'back', label: '← К черновикам' },
              ],
            };
          },
        }),
      );
      if (action === 'restore') return context.request('drafts.get', location);
      if (
        action === 'delete' &&
        selected(
          (await liveConfirm({
            title: 'Удаление черновика',
            message: 'Удалить это сохранённое сообщение?',
            body: 'Удаляется только черновик. Уже принятая задача продолжит работу.',
            active: 'Удалить черновик',
            inactive: 'Оставить',
            load: async () => {
              const current = await context.request('drafts.get', location);
              return {
                available: current.revision === draft.revision,
                detail:
                  current.revision === draft.revision
                    ? 'Выбранный черновик'
                    : 'Черновик изменён в другом окне',
              };
            },
          })) ?? false,
        )
      ) {
        await context.request('drafts.remove', { ...location, expectedRevision: draft.revision });
        offset = 0;
      }
    } catch (error) {
      if (!isMissingResource(error, 'draft')) throw error;
    }
  }
}

/** Повтор CLI с тем же текстом возвращается к неподтверждённому запросу, сохраняя его ключ. */
export async function pendingDraft(
  context: CliContext,
  scope: DraftScope,
  text: string,
  key?: string,
): Promise<TaskDraft | undefined> {
  for (let offset = 0; ; offset += 20) {
    const page = await context.request('drafts.list', {
      scope,
      offset,
    });
    for (const item of page.items) {
      if (item.state !== 'pending' || (key && item.requestKey !== key)) continue;
      const draft = await context.request('drafts.get', {
        id: item.id,
        sessionId: scope.sessionId,
      });
      if (draft.text === text) return draft;
    }
    if (offset + page.items.length >= page.total) return undefined;
  }
}
