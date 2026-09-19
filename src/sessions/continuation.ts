import { ApplicationError } from '../shared/application-error.js';
import { z } from 'zod';
import type { AgentState, RunRecord } from './types.js';
import type { SessionReader, RunCatalogEntry } from './ports.js';
import type { ChatMessage } from '../providers/types.js';
import { requiresOutcomeReview } from './invocations.js';

/** Выбирает видимый конец цепочки; дата нужна только старым записям без связей между этапами. */
export function latestSessionRun<
  T extends Pick<RunRecord, 'id' | 'parentRunId' | 'deletedAt' | 'createdAt'>,
>(runs: T[]): T | undefined {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const visible = runs.filter((run) => !run.deletedAt);
  const ancestors = new Set<string>();
  const visited = new Set<string>();
  for (const run of visible) {
    const path = new Set([run.id]);
    let parentId = run.parentRunId;
    while (parentId) {
      if (path.has(parentId)) throw new Error('Повреждена цепочка этапов беседы: обнаружен цикл.');
      ancestors.add(parentId);
      if (visited.has(parentId)) break;
      path.add(parentId);
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentRunId;
    }
  }
  return visible
    .filter((run) => !ancestors.has(run.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .at(-1);
}

/** Проверяет неизвестные побочные эффекты во всей беседе, включая скрытые этапы. */
export function assertKnownSessionOutcomes(runs: Array<RunRecord | RunCatalogEntry>): void {
  if (
    runs.some((run) =>
      'unknownOutcome' in run
        ? run.unknownOutcome
        : Object.values(run.invocations).some(requiresOutcomeReview) ||
          run.fileChanges?.some((change) => change.status === 'restoring'),
    )
  )
    throw new ApplicationError(
      'UNKNOWN_OUTCOME',
      'В этой беседе осталась операция с неизвестным результатом. Сначала проверьте её в действиях исходной задачи.',
    );
}

/** Отбирает подтверждённые факты, которых ещё нет в истории или сохранённой сводке роли. */
export function missingSessionCorrections(
  corrections: ChatMessage[],
  agent: AgentState,
): ChatMessage[] {
  return corrections.filter(
    (correction) =>
      !agent.summary.includes(correction.content) &&
      !agent.messages.some(
        (message) => message.role === 'user' && message.content === correction.content,
      ),
  );
}

/** Переносит поздние проверки и откаты прежних этапов с датой события, включая скрытые задачи. */
export async function sessionCorrections(
  store: SessionReader,
  runs: Array<RunRecord | RunCatalogEntry>,
): Promise<ChatMessage[]> {
  const fileMessages: ChatMessage[] = [];
  const facts: Array<{
    runId: string;
    tool: string;
    callId: string;
    status: string;
    result?: string;
  }> = [];
  for (const entry of runs) {
    const run = await store.load(entry.id);
    const restorations = new Map<string, ChatMessage>();
    const resolved = new Set<string>();
    let cursor = 0;
    while (true) {
      const page = await store.history(run.id, cursor, 100);
      if (!page.length) break;
      for (const event of page) {
        if (event.type === 'tool.human_resolved') {
          resolved.add(z.object({ invocationId: z.string() }).parse(event.payload).invocationId);
          continue;
        }
        if (!['file.restored', 'file.restore_resolved'].includes(event.type)) continue;
        const { changeId } = z.object({ changeId: z.string() }).parse(event.payload);
        const change = event.state.fileChanges?.find((item) => item.id === changeId);
        if (!change) continue;
        restorations.set(changeId, {
          role: 'user',
          content:
            (event.type === 'file.restored'
              ? '[Harness: пользователь восстановил исходное состояние файла ' + change.path + ']'
              : '[Harness: проверенный пользователем исход восстановления файла]') +
            '\n' +
            JSON.stringify({
              runId: run.id,
              at: event.at,
              path: change.path,
              status: change.status,
              ...(event.type === 'file.restore_resolved' ? change.resolution : {}),
            }),
        });
      }
      cursor = page.at(-1)!.seq;
    }
    fileMessages.push(...restorations.values());
    for (const invocationId of resolved) {
      const invocation = run.invocations[invocationId];
      if (invocation && ['succeeded', 'error'].includes(invocation.status))
        facts.push({
          runId: run.id,
          tool: invocation.call.name,
          callId: invocation.call.id,
          status: invocation.status,
          result: invocation.result,
        });
    }
  }
  const toolMessages: ChatMessage[] = facts.length
    ? [
        {
          role: 'user',
          content:
            '[Harness: результаты прерванных операций, проверенные пользователем]\n' +
            JSON.stringify(facts),
        },
      ]
    : [];
  return [...toolMessages, ...fileMessages];
}
