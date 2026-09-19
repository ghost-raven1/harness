import type { ProjectView } from '../../../projects/types.js';
import { id } from '../../../shared/primitives.js';
import { applicationErrorData } from '../../../shared/application-error.js';
import type { CliContext } from '../../types.js';
import { decideApprovals, selected } from '../../ui.js';
import { liveSelect } from '../live-select.js';
import { liveConfirm } from '../live-confirm.js';
import { followRun } from '../watch.js';
import { acceptPlan, editPlanOption, requestPlan } from './plan.js';
import { manualProjectCheck, resolveProjectOperation } from './checks.js';
import { confirmProject } from './confirm.js';
import { submitProjectDraft, projectDraft } from './drafts.js';
import { externalChangesText, projectTabs } from './format.js';
import { editProjectPlan } from './editor.js';
import { inspectPlanVersions } from './plan-history.js';
import { browseProjectReports } from './reports.js';
import { reviewProject } from './review.js';
import { exportProject } from './export.js';

/** Сообщение хранит адрес этапа и ключ запроса, даже если окно закрылось при отправке. */
async function messageProject(context: CliContext, view: ProjectView): Promise<void> {
  const stageId = selected(
    await liveSelect({
      title: 'Уточнение этапу',
      load: async () => {
        const current = await context.request('projects.detail', { projectId: view.projectId });
        return {
          message: 'Кому передать уточнение?',
          options: [
            ...current.stages
              .filter((item) => item.status === 'running')
              .map((item) => ({ value: item.stageId, label: item.title })),
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (stageId === 'back') return;
  const current = await context.request('projects.detail', { projectId: view.projectId });
  const draft = await projectDraft(
    context,
    {
      workspace: view.workspace,
      profile: view.profile,
      purpose: 'project.message',
      projectId: view.projectId,
      stageId,
    },
    'Что уточнить работающему этапу?',
    current,
  );
  await submitProjectDraft(context, draft, () =>
    context.request('projects.message', {
      projectId: view.projectId,
      expectedRevision: draft.expectedProjectRevision ?? current.revision,
      requestKey: draft.requestKey,
      stageId,
      message: draft.text,
    }),
  );
}

/** Предпросмотр перечисляет каскад; второе окно может отозвать возможность удаления. */
async function purgeProject(context: CliContext, view: ProjectView): Promise<boolean> {
  const preview = await context.request('projects.purgePreview', { projectId: view.projectId });
  const confirmed = await liveConfirm({
    title: 'Удаление проекта навсегда',
    message: 'Удалить проект и перечисленную историю?',
    active: 'Удалить',
    inactive: 'Оставить',
    body: [
      view.title,
      'Задач: ' + preview.runs,
      'Бесед: ' + preview.sessions,
      'Артефактов: ' + preview.artifacts,
      'Будут удалены план, история проекта, связанные задачи и черновики.',
      'Файлы в рабочей папке останутся.',
      ...preview.blockers,
    ].join('\n'),
    load: async () => {
      const current = await context.request('projects.purgePreview', { projectId: view.projectId });
      return {
        available: current.available && current.previewToken === preview.previewToken,
        detail:
          current.previewToken === preview.previewToken
            ? current.blockers.join(' · ')
            : 'Состав изменился · откройте предпросмотр заново',
      };
    },
  });
  if (confirmed !== true) return false;
  await context.request('projects.purge', {
    projectId: view.projectId,
    expectedRevision: view.revision,
    requestKey: id(),
    previewToken: preview.previewToken,
  });
  return true;
}

/** Выбор журнала доступен и после завершения проекта; управление остаётся в его карточке. */
async function inspectStage(context: CliContext, view: ProjectView): Promise<void> {
  const choice = selected(
    await liveSelect({
      title: 'Журналы этапов',
      load: async () => {
        const current = await context.request('projects.detail', { projectId: view.projectId });
        const runs = new Map<string, string>();
        if (current.currentRunId) runs.set(current.currentRunId, 'Текущая работа проекта');
        for (const stage of current.stages) if (stage.runId) runs.set(stage.runId, stage.title);
        for (const report of current.reports)
          if (report.runId && !runs.has(report.runId))
            runs.set(report.runId, 'Проверка · ' + report.at);
        return {
          message: 'Открыть журнал, мысли и ответ',
          options: [
            ...[...runs].map(([value, label]) => ({ value, label })),
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (choice !== 'back') await followRun(context, choice, { inspect: true, projectManaged: true });
}

/** Выполняет действие с реквизитами показанной карточки; сервер повторно проверяет переход. */
export async function projectAction(
  context: CliContext,
  view: ProjectView,
  action: string,
  enhanced = false,
): Promise<boolean> {
  const ref = { projectId: view.projectId, expectedRevision: view.revision, requestKey: id() };
  if (action === 'plan') await requestPlan(context, view);
  if (action === 'acceptPlan') await acceptPlan(context, view, enhanced);
  if (action === 'editPlan')
    await (enhanced ? editProjectPlan(context, view) : editPlanOption(context, view));
  if (enhanced && action === 'reports') await browseProjectReports(context, view.projectId);
  if (enhanced && action === 'review') await reviewProject(context, view.projectId);
  if (enhanced && action === 'versions') await inspectPlanVersions(context, view.projectId);
  if (enhanced && action === 'export') await exportProject(context, view.projectId);
  if (enhanced && action === 'accept') await reviewProject(context, view.projectId, true);
  if (action === 'baseline') await editPlanOption(context, view, true);
  if (action === 'message') await messageProject(context, view);
  if (action === 'manualCheck') await manualProjectCheck(context, view);
  if (action === 'resolve') await resolveProjectOperation(context, view);
  if (action === 'approvals') {
    const current = await context.request('projects.detail', { projectId: view.projectId });
    if (current.currentRunId && (current.pendingApprovals ?? 0) > 0)
      await decideApprovals(context.directory(), current.currentRunId);
  }
  if (action === 'logs') await inspectStage(context, view);
  if (action === 'pause') await context.request('projects.pause', ref);
  if (action === 'recheck') await context.request('projects.recheck', ref);
  if (action === 'resume') await resumeProject(context, view);
  if (
    action === 'cancel' &&
    (await confirmProject(
      context,
      view,
      'cancel',
      'Остановить проект?',
      'Работа этапов остановится. План, переписка и полученные файлы сохранятся.',
      'Остановить',
    ))
  )
    await context.request('projects.cancel', ref);
  if (
    !enhanced &&
    action === 'accept' &&
    view.resultRevision &&
    (await confirmProject(
      context,
      view,
      'accept',
      'Принять итог проекта?',
      projectTabs(view)
        .slice(0, 3)
        .filter((tab) => tab.id !== 'plan')
        .map((tab) => tab.text)
        .join('\n\n'),
      'Принять результат',
    ))
  )
    await context.request('projects.accept', {
      ...ref,
      expectedResultRevision: view.resultRevision,
    });
  if (action === 'archive')
    await context.request('projects.archive', { ...ref, archived: !view.archivedAt });
  if (action === 'purge') return purgeProject(context, view);
  return false;
}

/** Отдельное решение требуется после обнаружения внешних правок, даже если карточка ещё не содержала их. */
export async function resumeProject(context: CliContext, view: ProjectView): Promise<void> {
  try {
    await context.request('projects.resume', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: id(),
      acceptChanges: false,
    });
  } catch (error) {
    if (applicationErrorData(error)?.code !== 'PROJECT_CHANGED') throw error;
    const current = await context.request('projects.detail', { projectId: view.projectId });
    if (
      await confirmProject(
        context,
        current,
        'resume',
        'Продолжить с изменёнными файлами?',
        'Файлы изменились после паузы. Проверьте изменения в рабочей папке:\n' +
          current.workspace +
          '\n\n' +
          externalChangesText(current) +
          '\n\nПосле продолжения прежние проверки не подтверждают новое состояние. Итог потребуется проверить заново.',
        'Продолжить',
      )
    )
      await context.request('projects.resume', {
        projectId: view.projectId,
        expectedRevision: current.revision,
        requestKey: id(),
        acceptChanges: true,
      });
  }
}
