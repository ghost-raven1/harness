import * as prompts from '@clack/prompts';
import type { CliContext, LearningInspectView, LearningStatusView } from '../types.js';
import { selected } from '../ui.js';
import { explainError } from './errors.js';
import { page, terminalText } from './screen.js';
import { fitLine } from './terminal-layout.js';
import { readText } from './text-reader.js';
import { liveSelect } from './live-select.js';
import { learningVersionLabel } from './learning-labels.js';
import { knowledgeTabs, lessonLabels, knowledgeText, releaseText } from './knowledge-format.js';
import { isMissingResource, ResourceNotFoundError } from '../../shared/resource-errors.js';

/** Поиск и страницы охватывают все уроки; применение определяется составом активного выпуска. */
export function queryKnowledge(
  state: LearningStatusView,
  query = '',
  activeOnly = false,
  pageIndex = 0,
  size = 6,
) {
  const active = new Set(state.activeCandidateIds ?? []);
  const needle = query.trim().toLocaleLowerCase();
  const lessons = state.candidates
    .slice()
    .reverse()
    .filter(
      (candidate) =>
        (!activeOnly || active.has(candidate.id)) &&
        [
          candidate.id,
          candidate.title,
          candidate.workspace,
          candidate.role,
          candidate.profile,
          candidate.reason,
        ].some((value) => value?.toLocaleLowerCase().includes(needle)),
    );
  const pages = Math.max(1, Math.ceil(lessons.length / size));
  const current = Math.max(0, Math.min(pageIndex, pages - 1));
  return {
    items: lessons.slice(current * size, (current + 1) * size),
    page: current,
    pages,
    total: lessons.length,
  };
}

/** Каталог знаний доступен без запуска модели и без изменения накопленного опыта. */
export async function browseKnowledge(context: CliContext): Promise<void> {
  let query = '',
    pageIndex = 0,
    activeOnly = false;
  while (true) {
    const action = selected(
      await liveSelect({
        title: 'База знаний',
        load: async () => {
          const state = await context.request<LearningStatusView>('learning.status');
          const active = new Set(state.activeCandidateIds ?? []);
          const catalogue = queryKnowledge(state, query, activeOnly, pageIndex);
          return {
            summary:
              learningVersionLabel(state.activeVersion) +
              '\nУроков: ' +
              state.candidates.length +
              ' · Применяется: ' +
              active.size +
              '\nВ очереди: ' +
              state.jobs.filter((job) => job.status === 'queued').length +
              (query ? '\nПоиск: ' + terminalText(query) : ''),
            summaryTitle: activeOnly ? 'Применяемые уроки' : 'Все накопленные уроки',
            message: catalogue.total
              ? 'Уроки · страница ' + (catalogue.page + 1) + '/' + catalogue.pages
              : query || activeOnly
                ? 'Подходящих уроков нет'
                : 'Уроков пока нет',
            options: [
              ...catalogue.items.map((candidate) => ({
                value: candidate.id,
                label: fitLine(
                  knowledgeText(candidate.title),
                  Math.max(1, (process.stdout.columns || 80) - 24),
                ),
                hint: active.has(candidate.id)
                  ? 'применяется'
                  : lessonLabels[candidate.status].toLocaleLowerCase(),
              })),
              { value: 'search', label: 'Найти урок' },
              ...(query ? [{ value: 'clear', label: 'Сбросить поиск' }] : []),
              {
                value: 'filter',
                label: activeOnly ? 'Показать все уроки' : 'Только применяемые уроки',
              },
              ...(catalogue.page + 1 < catalogue.pages
                ? [{ value: 'next', label: 'Следующая страница →' }]
                : []),
              ...(catalogue.page > 0
                ? [{ value: 'previous', label: '← Предыдущая страница' }]
                : []),
              { value: 'queue', label: 'Вся очередь обучения' },
              { value: 'releases', label: 'Версии и откаты' },
              { value: 'back', label: '← Назад' },
            ],
          };
        },
      }),
    );
    if (action === 'back') return;
    const state = await context.request<LearningStatusView>('learning.status');
    pageIndex = queryKnowledge(state, query, activeOnly, pageIndex).page;
    if (action === 'search') {
      page('Поиск по знаниям');
      query = selected(
        await prompts.text({ message: 'Название, роль, профиль или папка', initialValue: query }),
      ).trim();
      pageIndex = 0;
    } else if (action === 'clear') {
      query = '';
      pageIndex = 0;
    } else if (action === 'filter') {
      activeOnly = !activeOnly;
      pageIndex = 0;
    } else if (action === 'next') pageIndex++;
    else if (action === 'previous') pageIndex--;
    else if (action === 'queue')
      await readText(
        'Очередь обучения',
        [{ id: 'queue', label: 'Все задания', text: queueText(state) }],
        {
          load: async () => ({
            tabs: [
              {
                id: 'queue',
                label: 'Все задания',
                text: queueText(await context.request<LearningStatusView>('learning.status')),
              },
            ],
          }),
        },
      );
    else if (action === 'releases')
      await readText(
        'Версии знаний',
        [{ id: 'versions', label: 'Все выпуски', text: releaseText(state) }],
        {
          load: async () => ({
            tabs: [
              {
                id: 'versions',
                label: 'Все выпуски',
                text: releaseText(await context.request<LearningStatusView>('learning.status')),
              },
            ],
          }),
        },
      );
    else await inspectKnowledge(context, action);
  }
}

/** При удалении урока во время просмотра возвращает понятный экран вместо старого текста. */
async function inspectKnowledge(context: CliContext, id: string): Promise<void> {
  try {
    await readKnowledge(context, id);
  } catch (error) {
    if (!isMissingResource(error, 'lesson')) throw error;
    await readText('Урок удалён', [
      {
        id: 'removed',
        label: 'Урок',
        text: 'Урок удалён в другом окне. Esc — к списку уроков.',
      },
    ]);
  }
}

/** Обновляет урок и его применимость; экспорт доступен отдельным действием. */
async function readKnowledge(context: CliContext, id: string): Promise<void> {
  const loadLesson = async () => {
    const [detail, state] = await Promise.all([
      context.request<LearningInspectView>('learning.inspect', { id }),
      context.request<LearningStatusView>('learning.status'),
    ]);
    if (!state.candidates.some((candidate) => candidate.id === id))
      throw new ResourceNotFoundError('lesson');
    const active = state.activeCandidateIds?.includes(id) ?? false;
    return { detail, active };
  };
  const loadReader = async () => {
    const { detail, active } = await loadLesson();
    return {
      tabs: knowledgeTabs(detail, active),
      subtitle: active
        ? 'Применяется · ' + detail.candidate.role
        : 'Не применяется · ' + lessonLabels[detail.candidate.status],
    };
  };
  while (true) {
    const initial = await loadReader();
    const result = await readText('Урок · ' + id.slice(0, 8), initial.tabs, {
      subtitle: initial.subtitle,
      actionLabel: 'действия с уроком',
      load: loadReader,
      exitOnError: (error) => isMissingResource(error, 'lesson'),
    });
    if (result === 'back') return;
    const action = await liveSelect({
      title: 'Действия с уроком',
      load: async () => {
        try {
          const { detail, active } = await loadLesson();
          return {
            summary: active
              ? 'Урок применяется.'
              : 'Не применяется · ' + lessonLabels[detail.candidate.status],
            message: fitLine(
              knowledgeText(detail.candidate.title),
              Math.max(1, (process.stdout.columns || 80) - 6),
            ),
            options: [
              { value: 'read', label: 'Вернуться к чтению' },
              { value: 'save', label: 'Сохранить урок в Markdown', hint: 'новый локальный файл' },
              { value: 'back', label: '← К списку уроков' },
            ],
          };
        } catch (error) {
          if (!isMissingResource(error, 'lesson')) throw error;
          return {
            summary: 'Урок удалён в другом окне.',
            message: 'Просмотр завершён',
            options: [{ value: 'back', label: '← К списку уроков' }],
          };
        }
      },
    });
    if (typeof action === 'symbol' || action === 'back') return;
    if (action === 'save') {
      let title = 'Урок сохранён',
        content: string;
      try {
        const { path, exists } = await context.request<{ path: string; exists?: boolean }>(
          'learning.export',
          { id },
        );
        if (exists) title = 'Файл уже существует';
        content = exists
          ? 'Существующий файл сохранён без изменений:\n' + path
          : 'Файл:\n' +
            path +
            '\n\nСохранены урок, область применения, ссылки на источники и сводка оценки. Исходные результаты инструментов доступны на вкладке «Доказательства».';
      } catch (error) {
        if (isMissingResource(error, 'lesson')) throw error;
        title = 'Не удалось сохранить урок';
        content = explainError(error);
      }
      await readText(title, [{ id: 'saved', label: 'Файл', text: content }]);
    }
  }
}

/** Показывает все задания обучения с состояниями и причинами остановки. */
function queueText(state: LearningStatusView): string {
  const labels = { queued: 'Ожидает обработки', done: 'Обработано', inactive: 'Неактивно' };
  return knowledgeText(
    state.jobs.length
      ? state.jobs
          .map((job) =>
            [
              labels[job.status] + ' · ' + job.role,
              'Задача: ' + job.runId,
              job.candidateId ? 'Урок: ' + job.candidateId : 'Урок ещё не сформирован.',
              job.error ? 'Причина: ' + job.error : '',
              'ID задания: ' + job.id,
            ]
              .filter(Boolean)
              .join('\n'),
          )
          .join('\n\n')
      : 'Очередь пуста. Задания появляются после завершения задач с проверяемыми результатами или подтверждения человека.',
  );
}
