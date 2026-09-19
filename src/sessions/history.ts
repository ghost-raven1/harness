import type { RunRecord } from './types.js';
import type { RunCatalogEntry } from './ports.js';

/** Каталог и производный поиск обслуживают меню без чтения полного состояния задач. */
export function queryCatalogHistory(
  runs: RunCatalogEntry[],
  matchingIds: Set<string>,
  page = 0,
  limit = 10,
) {
  const sorted = [...runs].reverse();
  const active = (run: RunCatalogEntry) =>
    ['running', 'awaiting_approval', 'paused'].includes(run.status);
  const summary = (run: RunCatalogEntry) => ({
    runId: run.id,
    status: run.status,
    task: run.task,
    taskTruncated: run.taskTruncated,
    profile: run.profile,
    workspace: run.workspace,
    createdAt: run.createdAt,
    deletedAt: run.deletedAt,
  });
  const completed = sorted.filter((run) => !active(run) && matchingIds.has(run.id));
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
