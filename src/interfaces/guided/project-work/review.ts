import { liveSelect } from '../live-select.js';
import { browseProjectChanges } from './changes.js';
import { browseProjectReports } from './reports.js';
import type { ProjectReview } from '../../../projects/read-schema.js';
import type { CliContext } from '../../types.js';
import { id } from '../../../shared/primitives.js';
import { readText, type TextTab } from '../text-reader.js';
import { liveConfirm } from '../live-confirm.js';
import { checkLabels, phaseLabels } from './reports.js';
import { supportsInsights } from '../specialists/capability.js';
import { browseProjectSpecialists } from '../specialists/project.js';

const freshnessLabels = {
  current: 'Файлы соответствуют проверкам',
  changed: 'Файлы изменились · нужны повторные проверки',
  unavailable: 'Состояние файлов недоступно',
  not_checked: 'Проверенного результата пока нет',
};
/** Приёмка строится только по сохранённым результатам; недоступные доказательства явно отмечаются. */
export function reviewTabs(review: ProjectReview): TextTab[] {
  return [
    {
      id: 'result',
      label: 'Результат',
      text: [
        review.title,
        review.goal,
        `\nПринятый план: ${review.acceptedVersion ?? 'ещё не принят'}`,
        freshnessLabels[review.freshness],
        `Проверено: ${review.checkedAt}`,
        review.freshnessReason ?? '',
        ...review.blockers,
        ...review.stages.map(
          (stage) =>
            `\n${stage.title}\nОжидалось:\n${stage.expected}\nПолучено:\n${stage.received || 'Результат не сохранён.'}\nПодтверждено: ${stage.confirmed ? 'да' : 'нет'} · попытка ${stage.attempt}${stage.manualInstructions ? '\nРучная проверка: ' + stage.manualInstructions : ''}`,
        ),
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      id: 'proof',
      label: 'Доказательства',
      text:
        review.reports
          .filter((report) => report.current)
          .map((report) =>
            [
              phaseLabels[report.phase],
              `Попытка ${report.attempt} · ${report.at}`,
              report.note ?? '',
              ...report.checks.map(
                (check) =>
                  `${check.title}: ${checkLabels[check.state]}${check.exitCode === undefined ? '' : ` · код ${check.exitCode}`}\n${check.reason ?? ''}`,
              ),
            ].join('\n'),
          )
          .join('\n\n') || 'Доказательств для принятой версии пока нет.',
    },
    {
      id: 'files',
      label: 'Файлы',
      text: [
        freshnessLabels[review.freshness],
        `Проверено: ${review.checkedAt}`,
        ...review.changes.map(
          (change) => `${{ added: '+', modified: '~', deleted: '−' }[change.kind]} ${change.path}`,
        ),
        review.changesTruncated
          ? 'Показана часть изменений. Полный состав проверьте в рабочей папке.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      id: 'history',
      label: 'Старые попытки',
      text:
        review.reports
          .filter((report) => !report.current)
          .map(
            (report) =>
              `${phaseLabels[report.phase]} · попытка ${report.attempt} · версия ${report.planVersion ?? 'не установлена'}\n${report.at}\n${report.note ?? ''}`,
          )
          .join('\n\n') || 'Старых попыток нет.',
    },
  ];
}

/** Открытие проверяет файлы без записи снимков; подтверждение проверяет их ещё раз. */
export async function reviewProject(
  context: CliContext,
  projectId: string,
  accept = false,
  diffs = false,
): Promise<void> {
  const insights = await supportsInsights(context);
  let review = await context.request('projects.review', { projectId });
  const load = async () => {
    const current = await context.request('projects.detail', { projectId });
    if (current.revision !== review.revision)
      review = await context.request('projects.review', { projectId });
    return {
      tabs: reviewTabs(review),
      actionLabel:
        accept && review.canAccept
          ? 'принять результат'
          : !accept && (diffs || insights)
            ? 'проверки и работа специалистов'
            : undefined,
    };
  };
  while (true) {
    const snapshot = await load();
    if (
      (await readText('Приёмка проекта', snapshot.tabs, {
        actionLabel: snapshot.actionLabel,
        load,
      })) !== 'action'
    )
      return;
    if (accept) break;
    const action = await liveSelect({
      title: 'Доказательства результата',
      load: async () => ({
        message: 'Что открыть?',
        options: [
          ...(diffs ? [{ value: 'changes', label: 'Изменения файлов · до и после' }] : []),
          ...(insights ? [{ value: 'specialists', label: 'Работа специалистов' }] : []),
          { value: 'checks', label: 'Проверки и полный вывод команд' },
          { value: 'read', label: '← К итогам' },
          { value: 'back', label: '← К проекту' },
        ],
      }),
    });
    if (typeof action === 'symbol' || action === 'back') return;
    if (action === 'changes' && diffs) await browseProjectChanges(context, projectId);
    if (action === 'checks') await browseProjectReports(context, projectId);
    if (action === 'specialists' && insights) await browseProjectSpecialists(context, projectId);
  }
  const confirmed = await liveConfirm({
    title: 'Приёмка проекта',
    message: 'Принять проверенный результат?',
    active: 'Принять результат',
    inactive: 'Назад',
    body: `${review.title}\n${freshnessLabels[review.freshness]}\nПроверено: ${review.checkedAt}\nЗавершённых этапов: ${review.stages.filter((stage) => stage.confirmed).length} из ${review.stages.length}`,
    load: async () => {
      const current = await context.request('projects.detail', { projectId });
      return {
        available:
          current.revision === review.revision && current.allowedActions.includes('accept'),
        detail:
          current.revision === review.revision
            ? 'Перед принятием файлы будут проверены повторно.'
            : 'Проект изменился. Откройте приёмку заново.',
      };
    },
  });
  if (confirmed !== true) return;
  const checked = await context.request('projects.review', { projectId });
  if (!checked.canAccept || checked.revision !== review.revision) {
    await readText('Приёмка требует проверки', reviewTabs(checked));
    return;
  }
  const current = await context.request('projects.detail', { projectId });
  if (!current.resultRevision)
    throw new Error('Проверенный результат недоступен. Повторите проверки.');
  await context.request('projects.accept', {
    projectId,
    expectedRevision: checked.revision,
    expectedResultRevision: current.resultRevision,
    requestKey: id(),
  });
}
