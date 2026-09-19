import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { isMissingResource } from '../../../shared/resource-errors.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { followRun } from '../watch.js';
import { browseProjectReports } from './reports.js';

type Interval = CommandResponse<'projects.changeSets'>['items'][number];
type ChangedFile = CommandResponse<'projects.changes'>['items'][number];
type FilePage = CommandResponse<'projects.fileChange'>;
type View = FilePage['view'];
const viewLabels: Record<View, string> = { diff: 'Изменения', before: 'До', after: 'После' };
const kinds: Record<Interval['kind'], string> = {
  project: 'Весь проект',
  stage: 'Работа этапа',
  checks: 'Проверочные команды',
  external: 'Изменения вне Harness',
  pause: 'До приостановки',
};
const outcomes: Record<Interval['outcome'], string> = {
  pending: 'Идёт работа · конечная точка ещё не сохранена',
  complete: 'Интервал сохранён',
  gap: 'Промежуток без полного снимка',
};
const fileKinds: Record<ChangedFile['kind'], string> = {
  added: '+ Добавлен',
  modified: '~ Изменён',
  deleted: '− Удалён',
};

/** Подпись сохраняет контекст попытки и не приписывает все изменения модели. */
export function changeSetLabel(interval: Interval): string {
  return (
    kinds[interval.kind] +
    (interval.stageTitle || interval.stageId
      ? ' · ' + (interval.stageTitle ?? interval.stageId)
      : '') +
    (interval.attempt === undefined ? '' : ' · попытка ' + interval.attempt)
  );
}

/** Сравниваются именно сохранённые точки; текущие файлы не подставляются вместо старых. */
export function changeSetText(interval: Interval): string {
  return [
    changeSetLabel(interval),
    outcomes[interval.outcome],
    `План: версия ${interval.planVersion}`,
    `До: ${interval.before.createdAt}`,
    `После: ${interval.after?.createdAt ?? 'ещё не сохранено'}`,
    interval.reason,
    'Изменения показывают состояние файлов за этот промежуток. Их могли внести Harness, редактор или другая программа.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Недоступный текст не заменяется пустым файлом или содержимым рабочей папки. */
export function fileChangePageText(page: FilePage): string {
  return [
    ...(page.path.length > 36 ? ['Файл: ' + page.path] : []),
    page.state === 'limited'
      ? 'Сравнение ограничено · сохранённые стороны доступны во вкладках «До» и «После».'
      : '',
    page.reason,
    page.text
      ? `Символы ${page.offset + 1}–${page.offset + page.text.length} из ${page.totalCharacters}${page.nextOffset === undefined ? '' : ' · продолжение через Enter'}`
      : '',
    page.text ||
      (page.state === 'available' ? 'Сохранённый текст пуст.' : 'Текст этой стороны недоступен.'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Карточка хранит только страницу каждого вида и закреплённый идентификатор интервала. */
export async function inspectProjectFile(
  context: CliContext,
  projectId: string,
  interval: Interval,
  file: ChangedFile,
): Promise<void> {
  const offsets: Record<View, number[]> = { diff: [0], before: [0], after: [0] };
  let pages: Record<View, FilePage> | undefined;
  const load = async () => {
    const values = await Promise.all(
      (['diff', 'before', 'after'] as const).map((view) =>
        context.request('projects.fileChange', {
          projectId,
          changeSetId: interval.id,
          fileId: file.fileId,
          view,
          offset: offsets[view].at(-1)!,
        }),
      ),
    );
    pages = { diff: values[0]!, before: values[1]!, after: values[2]! };
    return {
      tabs: (['diff', 'before', 'after'] as const).map((view) => ({
        id: view,
        label: viewLabels[view],
        text: fileChangePageText(pages![view]),
      })),
      subtitle: changeSetLabel(interval),
      actionLabel: 'страницы и связанные проверки',
      notice: [
        file.typeChanged ? 'Изменён тип файла' : '',
        file.executableChanged ? 'Изменены права исполнения' : '',
      ]
        .filter(Boolean)
        .join(' · '),
    };
  };
  while (true) {
    const snapshot =
      process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb'
        ? {
            tabs: (['diff', 'before', 'after'] as const).map((view) => ({
              id: view,
              label: viewLabels[view],
              text: 'Читаем сохранённое содержимое… Esc — вернуться к списку файлов.',
            })),
            subtitle: changeSetLabel(interval),
          }
        : await load();
    if (
      (await readText(file.path, snapshot.tabs, {
        ...snapshot,
        load,
        exitOnError: (error) => isMissingResource(error, 'project'),
      })) === 'back'
    )
      return;
    const action = await liveSelect({
      title: 'Изменения файла',
      load: async () => ({
        message: file.path,
        options: [
          ...(['diff', 'before', 'after'] as const).flatMap((view) => [
            ...(pages?.[view].nextOffset === undefined
              ? []
              : [{ value: `next:${view}`, label: 'Следующая страница · ' + viewLabels[view] }]),
            ...(offsets[view].length > 1
              ? [{ value: `previous:${view}`, label: 'Предыдущая страница · ' + viewLabels[view] }]
              : []),
          ]),
          ...(interval.runId ? [{ value: 'run', label: 'Открыть связанный запуск' }] : []),
          ...(interval.reportId ? [{ value: 'checks', label: 'Открыть проверки интервала' }] : []),
          { value: 'read', label: '← Читать файл' },
          { value: 'back', label: '← К списку файлов' },
        ],
      }),
    });
    if (typeof action === 'symbol' || action === 'back') return;
    if (action === 'run' && interval.runId)
      await followRun(context, interval.runId, { inspect: true, projectManaged: true });
    if (action === 'checks') await browseProjectReports(context, projectId, interval.reportId);
    const [direction, view] = action.split(':');
    if (view === 'diff' || view === 'before' || view === 'after') {
      if (direction === 'next' && pages?.[view].nextOffset !== undefined)
        offsets[view].push(pages[view].nextOffset!);
      if (direction === 'previous' && offsets[view].length > 1) offsets[view].pop();
    }
  }
}

/** Список файлов обновляется, сохраняя выбранный fileId при появлении новых результатов. */
export async function browseIntervalFiles(
  context: CliContext,
  projectId: string,
  interval: Interval,
): Promise<void> {
  let offset = 0;
  let selection: string | undefined;
  while (true) {
    const load = () =>
      context.request('projects.changes', { projectId, changeSetId: interval.id, offset });
    let files: ChangedFile[] = [];
    const action = await liveSelect({
      title: 'Изменения файлов',
      initialValue: selection,
      exitOnError: (error) => isMissingResource(error, 'project'),
      load: async () => {
        const page = await load();
        interval = page.interval ?? interval;
        files = page.items;
        return {
          summary: `${changeSetLabel(interval)}\n${outcomes[interval.outcome]}\nФайлов: ${page.total}${page.reason ? '\n' + page.reason : ''}`,
          message: 'Выберите файл для сравнения',
          options: [
            ...page.items.map((item) => ({
              value: 'file:' + item.fileId,
              label: item.path,
              hint: [
                fileKinds[item.kind],
                item.typeChanged ? 'тип изменён' : '',
                item.executableChanged ? 'права изменены' : '',
              ]
                .filter(Boolean)
                .join(' · '),
            })),
            { value: 'interval', label: 'Границы интервала и пояснения' },
            ...(interval.runId ? [{ value: 'run', label: 'Связанный запуск' }] : []),
            ...(interval.reportId ? [{ value: 'checks', label: 'Проверки интервала' }] : []),
            ...(page.nextOffset === undefined
              ? []
              : [{ value: 'next', label: 'Следующая страница →' }]),
            ...(offset ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
            { value: 'back', label: '← К интервалам' },
          ],
        };
      },
    });
    if (typeof action === 'symbol' || action === 'back') return;
    selection = action;
    if (action === 'next') {
      offset += 20;
      selection = undefined;
    }
    if (action === 'previous') {
      offset = Math.max(0, offset - 20);
      selection = undefined;
    }
    if (action === 'interval')
      await readText('Сохранённый интервал', [
        { id: 'interval', label: 'Границы', text: changeSetText(interval) },
      ]);
    if (action === 'run' && interval.runId)
      await followRun(context, interval.runId, { inspect: true, projectManaged: true });
    if (action === 'checks') await browseProjectReports(context, projectId, interval.reportId);
    if (action.startsWith('file:')) {
      const selectedId = action.slice(5);
      if (!files.some((file) => file.fileId === selectedId)) continue;
      const current = (await load()).items.find((file) => file.fileId === selectedId);
      if (current) await inspectProjectFile(context, projectId, interval, current);
    }
  }
}

/** Пользователь выбирает неизменный интервал, а новые этапы добавляются в список отдельно. */
export async function browseProjectChanges(context: CliContext, projectId: string): Promise<void> {
  let offset = 0;
  let selection: string | undefined;
  while (true) {
    const load = () => context.request('projects.changeSets', { projectId, offset });
    const choice = await liveSelect({
      title: 'Изменения проекта',
      initialValue: selection,
      exitOnError: (error) => isMissingResource(error, 'project'),
      load: async () => {
        const page = await load();
        return {
          summary: page.total
            ? `Сохранённых промежутков: ${page.total}`
            : 'История содержимого пока не сохранена. Для старых проектов доступны только прежние метаданные.',
          message: 'Какой промежуток сравнить?',
          options: [
            ...page.items.map((interval) => ({
              value: 'interval:' + interval.id,
              label: changeSetLabel(interval),
              hint: outcomes[interval.outcome],
            })),
            ...(page.nextOffset === undefined
              ? []
              : [{ value: 'next', label: 'Следующая страница →' }]),
            ...(offset ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
            { value: 'back', label: '← К проекту' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    selection = choice;
    if (choice === 'next') {
      offset += 20;
      selection = undefined;
    }
    if (choice === 'previous') {
      offset = Math.max(0, offset - 20);
      selection = undefined;
    }
    if (choice.startsWith('interval:')) {
      const interval = (await load()).items.find((item) => item.id === choice.slice(9));
      if (interval) await browseIntervalFiles(context, projectId, interval);
    }
  }
}
