import { allChecks } from './plans.js';
import { hash } from '../shared/primitives.js';
import type { ProjectRecord } from './types.js';
import type { ProjectEvidenceService } from './evidence.js';
import type { ProjectReview, EvidenceReport } from './read-schema.js';

/** Соединяет ожидания, сохранённый результат и доказательства без дополнительного вызова модели. */
export async function buildProjectReview(
  project: ProjectRecord,
  evidence: ProjectEvidenceService,
): Promise<ProjectReview> {
  const { workspace, projects, sessions } = evidence.dependencies;
  const blockers: string[] = [];
  const runIndex = new Map(sessions.catalog(true).map((run) => [run.id, run]));
  const reports: EvidenceReport[] = [];
  for (const report of await evidence.sourceReports(project))
    reports.push(await evidence.describe(project, report, runIndex));
  let freshness: ProjectReview['freshness'] = 'not_checked';
  let freshnessReason: string | undefined;
  let checkedAt = new Date().toISOString();
  try {
    const current = await workspace.inspect(
      project.id,
      project.workspace,
      project.config.value.tools.deniedPaths,
    );
    if (project.resultSnapshot)
      freshness = current.digest === project.resultSnapshot.digest ? 'current' : 'changed';
    else freshnessReason = 'Итоговый результат ещё не проверен.';
  } catch {
    freshness = 'unavailable';
    freshnessReason = 'Не удалось проверить актуальность исходных файлов.';
  } finally {
    checkedAt = new Date().toISOString();
  }
  if (freshness !== 'current')
    blockers.push(freshnessReason ?? 'Файлы изменились после проверок. Нужна повторная проверка.');
  if (projects.recoveryError || sessions.recoveryError)
    blockers.push('Хранение требует восстановления.');
  if (project.runIds.some((id) => runIndex.get(id)?.unknownOutcome))
    blockers.push('Результат операции неизвестен. Требуется проверка человеком.');
  if (project.status !== 'review')
    blockers.push(
      project.status === 'completed'
        ? 'Результат уже принят.'
        : 'Проект ещё не готов к итоговой приёмке.',
    );
  if (project.plan?.version !== project.acceptedVersion)
    blockers.push('Текущая версия плана ещё не принята.');
  const currentReports = reports.filter((report) => report.current);
  const stages = (project.plan?.stages ?? []).map((stage) => {
    const state = project.stages[stage.id]!;
    const stageVersion = state.runId ? runIndex.get(state.runId)?.project?.planVersion : undefined;
    const selected = reports.filter(
      (report) =>
        report.stageId === stage.id &&
        report.attempt === state.attempt &&
        (report.current || (stageVersion !== undefined && report.planVersion === stageVersion)),
    );
    const inheritedEvidence = selected.some((report) => !report.current);
    const confirmed =
      stage.verification.kind === 'manual'
        ? state.manualRevision !== undefined &&
          state.manualRevision === project.resultSnapshot?.digest &&
          selected.some(
            (report) => report.status === 'passed' && !report.runId && report.checks.length === 0,
          )
        : selected.some(
            (report) =>
              report.phase === 'stage' &&
              report.status === 'passed' &&
              report.checks.length > 0 &&
              report.checks.every(
                (check) => check.evidence === 'available' && check.exitCode === 0,
              ),
          );
    return {
      id: stage.id,
      title: stage.title,
      expected: stage.expectedResult,
      received: state.summary ?? 'Результат этапа ещё не сохранён.',
      status: state.status,
      attempt: state.attempt,
      runId: state.runId,
      verification: stage.verification.kind,
      ...(stage.verification.kind === 'manual'
        ? { manualInstructions: stage.verification.instructions }
        : {}),
      confirmed,
      inheritedEvidence,
      reportIds: selected.map((report) => report.id),
    };
  });
  if (stages.some((stage) => stage.status !== 'completed'))
    blockers.push('Не все этапы завершены.');
  const commandStages =
    project.plan?.stages.filter((stage) => stage.verification.kind === 'commands') ?? [];
  const final = currentReports
    .filter(
      (report) =>
        report.phase === 'final' && report.workspaceRevision === project.resultSnapshot?.digest,
    )
    .at(-1);
  const expectedChecks = project.plan ? allChecks(project.plan) : [];
  const matched =
    final &&
    expectedChecks.every((expected) =>
      final.checks.some(
        (check) =>
          check.sourceId === expected.id &&
          hash({ command: check.command, args: check.args }) ===
            hash({ command: expected.command, args: expected.args }),
      ),
    );
  if (
    commandStages.length &&
    (!final ||
      !matched ||
      final.status !== 'passed' ||
      final.checks.some((check) => check.evidence !== 'available' || check.exitCode !== 0))
  )
    blockers.push('Нет доступных успешных итоговых проверок принятой версии.');
  if (stages.some((stage) => stage.verification === 'commands' && !stage.confirmed))
    blockers.push('Доказательства завершённого этапа недоступны.');
  if (stages.some((stage) => stage.verification === 'manual' && !stage.confirmed))
    blockers.push('Ручные проверки требуют подтверждения для текущих файлов.');
  let changes: ProjectReview['changes'] = [];
  try {
    const after = project.resultSnapshot ?? project.checkpoint;
    if (project.baseline && after)
      changes = await workspace.changes(project.id, project.baseline.ref, after.ref);
  } catch {
    blockers.push('Сохранённый список изменений недоступен.');
  }
  return {
    projectId: project.id,
    revision: project.revision,
    title: project.title,
    goal: project.goal,
    acceptedVersion: project.acceptedVersion,
    plan: project.plan,
    checkedAt,
    freshness,
    freshnessReason,
    canAccept: blockers.length === 0,
    blockers,
    stages,
    reports,
    changes: changes.slice(0, 1000),
    changesTruncated: changes.length > 1000,
  };
}
