import type { ProjectRunPort } from '../sessions/project-run.js';
import { projectSummary, ProjectStore } from './store.js';
import type { ProjectRecord, ProjectView } from './types.js';
import type { ProjectWorkspace } from './workspace.js';

/** Обзор отделяет утверждаемый план и доказательства от журнала модели. */
export async function projectView(
  project: ProjectRecord,
  store: ProjectStore,
  runs: ProjectRunPort,
  workspace: ProjectWorkspace,
  cursor = 0,
  eventLimit = 30,
): Promise<ProjectView> {
  const events = await store.events(project.id, cursor, eventLimit);
  const allowed: ProjectView['allowedActions'] = [];
  const busy = project.intent?.runId ? runs.busy(project.intent.runId) : false;
  const currentRun =
    busy && project.intent?.runId ? await runs.inspect(project.intent.runId) : undefined;
  const pendingApprovals = Object.values(currentRun?.approvals ?? {}).filter(
    (approval) => approval.status === 'pending',
  ).length;
  const awaitingApproval = pendingApprovals > 0 && project.status === 'running';
  const reason = awaitingApproval
    ? 'Требуется разрешение на действие. Откройте «Рассмотреть разрешения».'
    : project.reason;
  const reasonCode = awaitingApproval ? 'APPROVAL_REQUIRED' : project.reasonCode;
  if (
    !['completed', 'cancelled'].includes(project.status) &&
    !busy &&
    !['running', 'pausing', 'planning'].includes(project.status)
  )
    allowed.push('plan', 'editPlan');
  if (project.status === 'ready') allowed.push('acceptPlan');
  if (['running', 'planning'].includes(project.status)) allowed.push('pause', 'cancel');
  if (project.status === 'pausing') allowed.push('cancel');
  if (project.status === 'paused') {
    allowed.push('cancel');
    if (['MANUAL_CHECK', 'FINAL_MANUAL_CHECK'].includes(project.reasonCode ?? ''))
      allowed.push('manualCheck', 'recheck');
    else if (project.reasonCode === 'BASELINE_FAILED') allowed.push('editPlan');
    else allowed.push('resume', 'resolve');
  }
  if (project.status === 'review') allowed.push('accept', 'recheck');
  if (project.intent?.kind === 'stage' && ['running', 'paused'].includes(project.status))
    allowed.push('message');
  if (!busy && !['running', 'planning', 'pausing'].includes(project.status))
    allowed.push('archive', 'purge');
  const before = project.baseline,
    after = project.resultSnapshot ?? project.checkpoint;
  const changes = before && after ? await workspace.changes(project.id, before.ref, after.ref) : [];
  const externalChanges =
    project.externalSnapshot && project.checkpoint
      ? await workspace.changes(project.id, project.checkpoint.ref, project.externalSnapshot.ref)
      : [];
  return {
    ...projectSummary(project),
    goal: project.goal,
    plan: project.plan,
    planVersion: project.plan?.version,
    resultRevision: project.resultSnapshot?.digest,
    currentRunId: project.intent?.runId ?? project.runIds.at(-1),
    pendingApprovals,
    reason,
    reasonCode,
    allowedActions: [...new Set(allowed)],
    roles: Object.keys(project.config.value.roles).map((id) => ({ id, label: id })),
    stages: (project.plan?.stages ?? []).map((stage) => ({
      title: stage.title,
      ...project.stages[stage.id]!,
    })),
    reports: project.reports,
    changes: changes.slice(0, 1000),
    changesTruncated: changes.length > 1000,
    externalChanges: externalChanges.slice(0, 1000),
    externalChangesTruncated: externalChanges.length > 1000,
    blockers: reasonCode
      ? [
          {
            code: reasonCode,
            message: reason ?? 'Требуется решение человека.',
            runId: project.intent?.runId,
            stageId: project.intent?.stageId,
          },
        ]
      : [],
    events: {
      items: events,
      cursor: events.at(-1)?.seq ?? cursor,
      hasMore: (events.at(-1)?.seq ?? cursor) < project.revision,
    },
  };
}
