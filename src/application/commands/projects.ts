import { projectInputs } from '../../projects/schema.js';
import { ApplicationError } from '../../shared/application-error.js';
import type { Application } from '../bootstrap.js';
import { planReadCommands } from '../../projects/plan-schema.js';
import { projectReadInputs } from '../../projects/read-schema.js';

/** Проверяет параметры проекта на прикладной границе без зависимости от транспорта. */
export async function projectsCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  const recovery = app.sessions?.recoveryError || app.projects.store?.recoveryError;
  if (
    recovery &&
    ![
      'projects.list',
      'projects.detail',
      'projects.purgePreview',
      'projects.reports',
      'projects.checkOutput',
      'projects.review',
      'projects.planVersions',
      'projects.comparePlans',
      'projects.validatePlan',
    ].includes(method)
  )
    throw new ApplicationError('STORAGE_UNAVAILABLE', recovery);
  switch (method) {
    case 'projects.reports':
      return app.projectEvidence.reports(projectReadInputs.reports.parse(input));
    case 'projects.checkOutput':
      return app.projectEvidence.checkOutput(projectReadInputs.checkOutput.parse(input));
    case 'projects.review': {
      const review = await app.projectEvidence.review(projectReadInputs.review.parse(input));
      return recovery
        ? { ...review, canAccept: false, blockers: [recovery, ...review.blockers] }
        : review;
    }
    case 'projects.exportPreview':
      return app.projectExports.preview(projectReadInputs.exportPreview.parse(input));
    case 'projects.exportReport':
      return app.projectExports.export(projectReadInputs.exportReport.parse(input));
    case 'projects.planVersions':
      return app.projectPlans.planVersions(
        planReadCommands['projects.planVersions'].params.parse(input),
      );
    case 'projects.comparePlans':
      return app.projectPlans.comparePlans(
        planReadCommands['projects.comparePlans'].params.parse(input),
      );
    case 'projects.validatePlan':
      return app.projectPlans.validatePlan(
        planReadCommands['projects.validatePlan'].params.parse(input),
      );
    case 'projects.list':
      return app.projects.list(projectInputs.list.parse(input ?? {}));
    case 'projects.detail': {
      const view = await app.projects.detail(projectInputs.detail.parse(input));
      return recovery ? { ...view, allowedActions: [], reason: recovery } : view;
    }
    case 'projects.create':
      return app.projects.create(projectInputs.create.parse(input));
    case 'projects.plan':
      return app.projects.plan(projectInputs.plan.parse(input));
    case 'projects.editPlan':
      return app.projects.editPlan(projectInputs.editPlan.parse(input));
    case 'projects.acceptPlan':
      return app.projects.acceptPlan(projectInputs.acceptPlan.parse(input));
    case 'projects.pause':
      return app.projects.pause(projectInputs.pause.parse(input));
    case 'projects.resume':
      return app.projects.resume(projectInputs.resume.parse(input));
    case 'projects.cancel':
      return app.projects.cancel(projectInputs.cancel.parse(input));
    case 'projects.message':
      return app.projects.message(projectInputs.message.parse(input));
    case 'projects.manualCheck':
      return app.projects.manualCheck(projectInputs.manualCheck.parse(input));
    case 'projects.recheck':
      return app.projects.recheck(projectInputs.recheck.parse(input));
    case 'projects.accept':
      return app.projects.accept(projectInputs.accept.parse(input));
    case 'projects.archive':
      return app.projects.archive(projectInputs.archive.parse(input));
    case 'projects.resolve':
      return app.projects.resolve(projectInputs.resolve.parse(input));
    case 'projects.purgePreview': {
      const preview = await app.projects.purgePreview(projectInputs.purgePreview.parse(input));
      return recovery
        ? { ...preview, available: false, blockers: [...preview.blockers, recovery] }
        : preview;
    }
    case 'projects.purge':
      return app.projects.purge(projectInputs.purge.parse(input));
    default:
      throw new ApplicationError('UNKNOWN_COMMAND', 'Неизвестная команда проекта.');
  }
}
