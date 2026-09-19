import { id } from '../../../shared/primitives.js';
import type { ProjectView } from '../../../projects/types.js';
import type { CliContext } from '../../types.js';
import { liveConfirm } from '../live-confirm.js';

/** Настройка влияет на будущие снимки и не удаляет уже сохранённую историю. */
export async function changeProjectCapture(context: CliContext, view: ProjectView): Promise<void> {
  const enabled = view.capture?.enabled !== true;
  const confirmed = await liveConfirm({
    title: 'Содержимое файлов в истории',
    message: enabled
      ? 'Сохранять текст для будущих сравнений?'
      : 'Отключить сохранение новых текстов?',
    active: enabled ? 'Включить' : 'Отключить',
    inactive: 'Назад',
    body: [
      view.title,
      'Настройка применяется к следующим снимкам этого проекта. Старые снимки не переписываются и не удаляются.',
      'Секретные, бинарные и слишком большие файлы не сохраняются.',
      ...(view.capture
        ? [
            `Предел файла: ${(view.capture.fileBytes / 1048576).toLocaleString('ru-RU')} МиБ; проекта: ${(view.capture.projectBytes / 1048576).toLocaleString('ru-RU')} МиБ; всего: ${(view.capture.totalBytes / 1048576).toLocaleString('ru-RU')} МиБ.`,
          ]
        : []),
    ].join('\n\n'),
    load: async () => {
      const current = await context.request('projects.detail', { projectId: view.projectId });
      return {
        available:
          current.revision === view.revision &&
          ['draft', 'ready', 'paused'].includes(current.status),
        detail:
          current.revision === view.revision
            ? 'Только будущие снимки'
            : 'Проект изменился · обновите экран',
      };
    },
  });
  if (confirmed !== true) return;
  await context.request('projects.changeCapture', {
    projectId: view.projectId,
    expectedRevision: view.revision,
    requestKey: id(),
    enabled,
  });
}
