import type { RunRecord } from './types.js';

/** Закрепляет незавершённые задачи и постранично возвращает подходящую историю. */
export function queryHistory(runs: RunRecord[], query = '', page = 0, limit = 10) {
  const summary = (run: RunRecord) => ({
    runId: run.id,
    status: run.status,
    task: run.agents[run.rootAgentId]!.task,
    profile: run.profile,
    workspace: run.workspace,
    createdAt: run.createdAt,
    deletedAt: run.deletedAt,
  });
  const sorted = [...runs].reverse();
  const active = (run: RunRecord) =>
    ['running', 'awaiting_approval', 'paused'].includes(run.status);
  const needle = query.trim().toLocaleLowerCase();
  const completed = sorted.filter(
    (run) =>
      !active(run) &&
      [
        run.id,
        run.workspace,
        run.profile,
        run.agents[run.rootAgentId]!.task,
        run.result ?? '',
      ].some((value) => value.toLocaleLowerCase().includes(needle)),
  );
  const pages = Math.max(1, Math.ceil(completed.length / limit));
  const current = Math.min(page, pages - 1);
  return {
    active: sorted.filter(active).map(summary),
    items: completed.slice(current * limit, (current + 1) * limit).map(summary),
    page: current,
    pages,
    total: completed.length,
  };
}
