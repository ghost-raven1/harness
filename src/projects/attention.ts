import type { RunCatalogEntry } from '../sessions/ports.js';
import type { ProjectSummary } from './types.js';

type Attention = NonNullable<ProjectSummary['attention']>;

/** Вычисляет причины ожидания только по каталогам; переписки и отчёты не загружаются. */
export function projectAttention(
  projects: ProjectSummary[],
  runs: RunCatalogEntry[],
  recoveryError?: string,
): ProjectSummary[] {
  const grouped = new Map<string, RunCatalogEntry[]>();
  for (const run of runs) {
    if (!run.project || run.deletedAt) continue;
    const group = grouped.get(run.project.projectId) ?? [];
    group.push(run);
    grouped.set(run.project.projectId, group);
  }
  return projects.map((project) => ({
    ...project,
    attention: reasonFor(project, grouped.get(project.projectId) ?? [], recoveryError),
  }));
}

/** Неизвестный побочный эффект и отказ хранения всегда важнее обычного продолжения. */
function reasonFor(
  project: ProjectSummary,
  runs: RunCatalogEntry[],
  recoveryError?: string,
): Attention | undefined {
  const decision = (
    code: string,
    reason: string,
    action: Attention['action'],
    priority: number,
    run?: RunCatalogEntry,
  ): Attention => ({
    code,
    reason,
    action,
    priority,
    runId: run?.id ?? project.currentRunId,
    stageId: run?.project?.stageId ?? project.currentStageId,
  });
  if (recoveryError) return decision('STORAGE_UNAVAILABLE', recoveryError, 'inspect', 0);
  const unknown = runs.find((run) => run.unknownOutcome);
  if (unknown || project.reasonCode === 'UNKNOWN_OUTCOME')
    return decision(
      'UNKNOWN_OUTCOME',
      'Проверьте неизвестный результат операции.',
      'resolve',
      1,
      unknown,
    );
  if (['completed', 'cancelled'].includes(project.status)) return;
  const approval = runs.find((run) => run.pendingApprovals.length > 0);
  if (approval)
    return decision(
      'APPROVAL_REQUIRED',
      'Требуется разрешение на действие.',
      'approvals',
      2,
      approval,
    );
  const current = runs.find((run) => run.id === project.currentRunId);
  if (current?.pauseReason === 'provider' || project.reasonCode === 'provider') {
    const provider = current?.providerPause;
    return {
      ...decision(
        provider?.kind === 'quota' ? 'PROVIDER_QUOTA' : 'PROVIDER_LIMIT',
        provider?.kind === 'quota'
          ? 'Провайдер сообщил об исчерпании квоты. Проверьте подключение перед продолжением.'
          : 'Провайдер ограничил частоту запросов. Продолжение выполняется вручную.',
        'resume',
        3,
        current,
      ),
      retryAt: provider?.retryAt,
    };
  }
  if (['MANUAL_CHECK', 'FINAL_MANUAL_CHECK'].includes(project.reasonCode ?? ''))
    return decision(
      project.reasonCode!,
      project.reason ?? 'Проверьте результат этапа вручную.',
      'manualCheck',
      4,
    );
  if (project.status === 'ready')
    return decision('PLAN_ACCEPTANCE', 'Просмотрите и примите предложенный план.', 'acceptPlan', 5);
  if (project.status === 'review')
    return decision(
      'RESULT_ACCEPTANCE',
      'Проверки завершены. Рассмотрите результат проекта.',
      'review',
      6,
    );
  if (project.status === 'paused')
    return decision(
      project.reasonCode ?? 'PAUSED',
      project.reason ?? 'Проект приостановлен. Выберите дальнейшее действие.',
      'inspect',
      7,
    );
}
