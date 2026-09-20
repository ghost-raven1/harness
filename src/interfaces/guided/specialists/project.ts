import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { labels } from '../../ui.js';
import { isMissingResource } from '../../../shared/resource-errors.js';
import { liveSelect } from '../live-select.js';
import { supportsInsights } from './capability.js';
import { browseSpecialists } from './screens.js';

type Attempt = CommandResponse<'projects.insights'>['items'][number];
const kinds: Record<string, string> = {
  planning: 'Планирование',
  stage: 'Выполнение этапа',
  checks: 'Проверки',
};

/** Каждая попытка имеет собственный запуск: старые ошибки не смешиваются с исправлениями. */
export function projectAttemptLabel(item: Attempt): string {
  return [
    kinds[item.kind] ?? item.kind,
    item.stageId,
    item.attempt === undefined ? '' : `попытка ${item.attempt}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Проект показывает страницы запусков, не запрашивая истории всех специалистов сразу. */
export async function browseProjectSpecialists(
  context: CliContext,
  projectId: string,
): Promise<void> {
  if (!(await supportsInsights(context))) return;
  let offset = 0;
  let selection: string | undefined;
  const load = () => context.request('projects.insights', { projectId, offset, limit: 20 });
  while (true) {
    const choice = await liveSelect({
      title: 'Работа специалистов проекта',
      initialValue: selection,
      exitOnError: (error) => isMissingResource(error, 'project'),
      load: async () => {
        const page = await load();
        return {
          summary: `Запусков: ${page.total}\nПопытки показаны отдельно. Откройте запуск, чтобы увидеть его специалистов.`,
          message: page.total ? 'Выберите попытку' : 'Работа ещё не запускалась',
          options: [
            ...page.items.map((item) => ({
              value: 'run:' + item.runId,
              label: projectAttemptLabel(item),
              hint: `${labels[item.insights.status] ?? item.insights.status} · ${item.runId.slice(0, 8)}`,
            })),
            ...(page.offset + page.items.length < page.total
              ? [{ value: 'next', label: 'Следующая страница →' }]
              : []),
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
    if (choice.startsWith('run:')) {
      const current = (await load()).items.find((item) => item.runId === choice.slice(4));
      if (current)
        await browseSpecialists(context, current.runId, {
          projectId,
          stageId: current.stageId,
          attempt: current.attempt,
        });
    }
  }
}
