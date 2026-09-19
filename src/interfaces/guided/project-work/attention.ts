import type { ProjectSummary } from '../../../projects/types.js';
import type { CliContext } from '../../types.js';
import { projectAction } from './actions.js';
import { inspectProject } from './detail.js';

/** Список решений открывает выбранную цель лишь после повторной проверки ревизии и запуска. */
export async function openProjectDecision(
  context: CliContext,
  selected: ProjectSummary,
  diffs = false,
): Promise<void> {
  const view = await context.request('projects.detail', { projectId: selected.projectId });
  const attention = selected.attention;
  const sameRun = !attention?.runId || attention.runId === view.currentRunId;
  const sameStage =
    !attention?.stageId ||
    view.stages.some(
      (stage) =>
        stage.stageId === attention.stageId &&
        (stage.status === 'manual' || stage.status === 'blocked' || stage.status === 'running'),
    );
  if (attention && view.revision === selected.revision && sameRun && sameStage) {
    if (attention.action === 'review' && view.status === 'review')
      await projectAction(context, view, 'review', true, diffs);
    else if (attention.action === 'approvals' && (view.pendingApprovals ?? 0) > 0)
      await projectAction(context, view, 'approvals', true, diffs);
    else if (
      ['acceptPlan', 'manualCheck', 'resolve'].includes(attention.action) &&
      view.allowedActions.some((action) => action === attention.action)
    )
      await projectAction(context, view, attention.action, true, diffs);
  }
  await inspectProject(context, selected.projectId, true, diffs);
}
