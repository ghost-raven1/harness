import { ApplicationError } from '../shared/application-error.js';
import type { AgentState, RunRecord } from '../sessions/types.js';
import type { RunCatalogEntry, SessionReader } from '../sessions/ports.js';
import { ActivityReader } from './reader.js';
import { ActivityObserver } from './observer.js';
import { materialize } from './aggregate.js';
import type { RunInsights } from './schema.js';

/** Соединяет измерения с состоянием задачи без чтения переписок при построении меню. */
export class InsightsService {
  readonly reader: ActivityReader;
  readonly observer: ActivityObserver;
  constructor(
    directory: string,
    private readonly sessions: SessionReader,
  ) {
    this.reader = new ActivityReader(directory);
    this.observer = new ActivityObserver(this.reader);
  }
  /** Возвращает факты запуска; завершение модели не обозначает прохождение проверок. */
  async report(
    runId: string,
    agentId?: string,
    resultCursor = 0,
    agentOffset = 0,
    agentLimit = 50,
  ): Promise<RunInsights> {
    const run = await this.sessions.load(runId);
    if (agentId && !Object.hasOwn(run.agents, agentId))
      throw new ApplicationError('INVALID_REQUEST', 'В задаче нет указанного специалиста.');
    await this.observer.flush();
    const saved = await this.reader.read(runId);
    const data = materialize(saved.data, (spanId) => this.observer.elapsed(spanId));
    const partial = data.partial || this.observer.incomplete.has(runId);
    const agents = Object.values(run.agents);
    const offset = agentId ? 0 : agentOffset;
    const selected = agentId
      ? [run.agents[agentId]!]
      : agents.slice(offset, offset + Math.min(100, agentLimit));
    return {
      runId,
      status: run.status,
      profile: run.profile,
      completeness: partial ? 'partial' : saved.index.count ? 'complete' : 'unavailable',
      activeMs: data.activeMs,
      pauseMs: data.pauseMs,
      usage: data.usage,
      retries: data.retries,
      legacyUsage: run.usage,
      roles: data.roles.filter((role) => !agentId || role.agentId === agentId).slice(-256),
      roleCount: data.roles.length,
      rolesTruncated:
        data.roles.filter((role) => !agentId || role.agentId === agentId).length > 256,
      agentOffset: offset,
      agentTotal: agents.length,
      agents: selected.map((agent) => {
        const limit = agent.id === agentId ? 16384 : 1024;
        return {
          id: agent.id,
          parentId: agent.parentId,
          depth: agent.depth,
          role: agent.role,
          profile: run.config.value.roles[agent.role]?.modelProfile ?? run.profile,
          task: agent.task.slice(0, limit),
          taskTruncated: agent.task.length > limit,
          status: agent.status,
          result: agent.result?.slice(
            agent.id === agentId ? resultCursor : 0,
            (agent.id === agentId ? resultCursor : 0) + limit,
          ),
          resultCursor: agent.id === agentId ? resultCursor : 0,
          resultLength: agent.result?.length ?? 0,
          resultTruncated:
            (agent.result?.length ?? 0) > (agent.id === agentId ? resultCursor : 0) + limit,
          error: agent.error?.slice(0, limit),
          errorTruncated: (agent.error?.length ?? 0) > limit,
          phases: [
            ...new Set(
              data.open
                .filter(
                  (event) =>
                    event.agentId === agent.id &&
                    event.spanId &&
                    this.observer.elapsed(event.spanId) !== undefined,
                )
                .flatMap((event) => (event.phase ? [event.phase] : [])),
            ),
          ],
          elapsedMs: data.roles
            .filter((role) => role.agentId === agent.id)
            .reduce((sum, role) => sum + (role.phases.agent ?? 0), 0),
          reason: roleReason(run, agent)?.slice(0, limit),
        };
      }),
    };
  }
  /** Страница попыток использует каталог и техническую сводку, не загружая переписку. */
  async summary(run: RunCatalogEntry): Promise<RunInsights> {
    await this.observer.flush();
    const saved = await this.reader.read(run.id);
    const data = materialize(saved.data, (spanId) => this.observer.elapsed(spanId));
    return {
      runId: run.id,
      status: run.status,
      profile: run.profile,
      completeness:
        data.partial || this.observer.incomplete.has(run.id)
          ? 'partial'
          : saved.index.count
            ? 'complete'
            : 'unavailable',
      activeMs: data.activeMs,
      pauseMs: data.pauseMs,
      usage: data.usage,
      retries: data.retries,
      legacyUsage: run.usage,
      roles: [],
      agents: [],
      roleCount: data.roles.length,
    };
  }
  /** Читает страницу только существующей задачи, не предоставляя произвольный путь. */
  async activity(runId: string, cursor: number, limit: number, agentId?: string) {
    const run = await this.sessions.load(runId);
    if (agentId && !Object.hasOwn(run.agents, agentId))
      throw new ApplicationError('INVALID_REQUEST', 'В задаче нет указанного специалиста.');
    await this.observer.flush();
    const page = await this.reader.page(runId, cursor, Math.min(100, Math.max(1, limit)), agentId);
    const { data } = await this.reader.read(runId);
    const interrupted = data.open.some(
      (event) => !event.spanId || this.observer.elapsed(event.spanId) === undefined,
    );
    if (interrupted || data.partial || this.observer.incomplete.has(runId))
      page.completeness = 'partial';
    return page;
  }
}

/** Объяснение handoff берётся из подтверждённого вызова; при его отсутствии доступен общий план. */
function roleReason(run: RunRecord, agent: AgentState): string | undefined {
  const handoff = Object.values(run.invocations)
    .reverse()
    .find(
      (item) =>
        item.agentId === agent.id &&
        item.call.name === 'agents.handoff' &&
        item.status === 'succeeded',
    );
  if (handoff) {
    try {
      const args = JSON.parse(handoff.call.arguments) as { role?: unknown; reason?: unknown };
      if (args.role === agent.role && typeof args.reason === 'string') return args.reason;
    } catch {
      /* Повреждённые аргументы не заменяются выдуманным обоснованием. */
    }
  }
  return run.coordination?.plan?.reason;
}
