import type { ProjectPlan, ProjectSummary, ProjectView } from '../../../projects/types.js';
import type { TextTab } from '../text-reader.js';

export const projectStatusLabels: Record<ProjectSummary['status'], string> = {
  draft: 'Цель сохранена',
  planning: 'Подготовка плана',
  ready: 'План ждёт принятия',
  running: 'В работе',
  pausing: 'Приостанавливается',
  paused: 'Приостановлен',
  review: 'Результат ждёт приёмки',
  completed: 'Принят',
  cancelled: 'Остановлен',
};
const stageLabels = {
  pending: 'Ожидает',
  running: 'В работе',
  checking: 'Проверка',
  manual: 'Проверьте вручную',
  completed: 'Проверен',
  blocked: 'Нужно решение',
};

/** Сохраняет границы аргументов команды даже при пробелах, кавычках и переносах. */
export function checkCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((part) => (/^[\w./:@=-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}
/** Человек видит инструкции, зависимости и точные проверки до принятия плана. */
export function planText(plan: ProjectPlan | undefined, roles: ProjectView['roles'] = []): string {
  if (!plan) return 'План пока не подготовлен. Выберите «Предложить план» в действиях.';
  return [
    `Исправлений каждого этапа: ${plan.maxCorrections}`,
    'Исправление исходных ошибок: ' +
      (plan.fixBaselineFailures ? 'включено' : 'нужно отдельное решение'),
    ...plan.stages.map((stage, index) =>
      [
        `\n${index + 1}. ${stage.title}`,
        'Специалист: ' + (roles.find((role) => role.id === stage.role)?.label ?? stage.role),
        stage.dependsOn.length
          ? 'После этапов: ' +
            stage.dependsOn
              .map((id) => plan.stages.find((item) => item.id === id)?.title ?? id)
              .join(', ')
          : 'Можно начать без предыдущих этапов',
        stage.task,
        'Ожидаемый результат: ' + stage.expectedResult,
        stage.requiredTools.length ? 'Инструменты: ' + stage.requiredTools.join(', ') : '',
        stage.verification.kind === 'manual'
          ? 'Ручная проверка:\n' + stage.verification.instructions
          : 'Команды проверки:\n' +
            stage.verification.checks
              .map((check) => check.title + '\n  ' + checkCommand(check.command, check.args))
              .join('\n'),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n');
}
/** Краткая карточка не обрезает цель: полный текст доступен в соседнем разделе. */
export function projectSummary(view: ProjectSummary): string {
  return [
    view.title,
    projectStatusLabels[view.status],
    `Этапов проверено: ${view.progress.completed} из ${view.progress.total}`,
  ].join('\n');
}

/** Показывает внешний состав из закреплённого предпросмотра, не смешивая его с результатом этапов. */
export function externalChangesText(view: ProjectView): string {
  return [
    'Изменения после паузы:',
    ...(view.externalChanges ?? []).map(
      (item) => `${{ added: '+', modified: '~', deleted: '-' }[item.kind]} ${item.path}`,
    ),
    view.externalChangesTruncated
      ? 'Показана часть внешних изменений. Проверьте полный состав в рабочей папке.'
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
/** Формирует отдельные читаемые разделы вместо смешивания плана, результата и журнала. */
export function projectTabs(view: ProjectView): TextTab[] {
  return [
    {
      id: 'overview',
      label: 'Обзор',
      text: [
        projectSummary(view),
        '\nЦель:\n' + view.goal,
        '\nПапка: ' + view.workspace,
        'Профиль: ' + view.profile,
        view.reason,
        ...view.blockers.map((item) => item.message),
        view.externalChanges?.length ? '\n' + externalChangesText(view) : '',
        '\nЭтапы:',
        ...view.stages.map(
          (stage) =>
            `${stageLabels[stage.status]} · ${stage.title}` +
            (stage.summary ? '\n' + stage.summary : ''),
        ),
        '\nИзменённые файлы:',
        ...view.changes.map(
          (item) => `${{ added: '+', modified: '~', deleted: '-' }[item.kind]} ${item.path}`,
        ),
        view.changesTruncated
          ? 'Показана часть изменений. Полный состав проверьте в рабочей папке.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      id: 'plan',
      label: 'План',
      text:
        (view.plan ? 'Версия ' + view.plan.version + '\n\n' : '') + planText(view.plan, view.roles),
    },
    {
      id: 'checks',
      label: 'Проверки',
      text: view.reports.length
        ? view.reports
            .map((report) =>
              [
                `${{ baseline: 'Исходная проверка', stage: 'Проверка этапа', final: 'Итоговая проверка' }[report.phase]} · ${{ passed: 'Пройдена', failed: 'Есть ошибки', unknown: 'Результат неизвестен', manual: 'Ручная проверка' }[report.status]}`,
                report.at,
                report.note,
                ...report.checks.map((check) =>
                  [
                    check.title,
                    checkCommand(check.command, check.args),
                    'Состояние: ' +
                      check.status +
                      (check.exitCode === undefined ? '' : ' · код ' + check.exitCode),
                    check.summary,
                    check.artifactId ? 'Артефакт: ' + check.artifactId : '',
                  ]
                    .filter(Boolean)
                    .join('\n'),
                ),
              ]
                .filter(Boolean)
                .join('\n'),
            )
            .join('\n\n')
        : 'Проверок пока нет.',
    },
    {
      id: 'journal',
      label: 'Журнал',
      text:
        view.events.items.map((event) => event.at + '\n' + event.message).join('\n\n') ||
        'Событий пока нет.',
    },
  ];
}
