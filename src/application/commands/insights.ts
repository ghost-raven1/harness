import type { RunStatus } from '../../sessions/types.js';
import type { Application } from '../bootstrap.js';
import { insightCommands } from '../../insights/read-schema.js';

/** Прикладная связка измерений проекта использует закреплённые связи запусков. */
export async function insightsCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  if (method === 'runtime.insights') {
    const { runId, agentId, resultCursor, agentOffset, agentLimit } =
      insightCommands[method].params.parse(input);
    const report = await app.insights.report(runId, agentId, resultCursor, agentOffset, agentLimit);
    report.status = app.runtime.visibleStatus(runId, report.status as RunStatus);
    return report;
  }
  if (method === 'runtime.activity') {
    const { runId, cursor, limit, agentId } = insightCommands[method].params.parse(input);
    return app.insights.activity(runId, cursor, limit, agentId);
  }
  const { projectId, offset, limit } = insightCommands['projects.insights'].params.parse(input);
  const project = await app.projects.store.get(projectId);
  const members = new Set(project.runIds);
  const runs = app.sessions
    .catalog(true)
    .filter((run) => run.project?.projectId === project.id && members.has(run.id));
  const items = [];
  for (const run of runs.slice(offset, offset + limit))
    items.push({
      runId: run.id,
      stageId: run.project!.stageId,
      attempt: run.project!.attempt,
      kind: run.project!.kind,
      insights: await app.insights.summary(run),
    });
  return { projectId, items, total: runs.length, offset };
}
