import { z } from 'zod';
import type { AgentState, RunRecord } from './types.js';
import type { FileSessionStore } from './store.js';
import type { ChatMessage } from '../providers/types.js';
import { requiresOutcomeReview } from './invocations.js';

/** Выбирает видимый конец цепочки; дата нужна только старым записям без связей между этапами. */
export function latestSessionRun(runs: RunRecord[]): RunRecord | undefined {
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
export function assertKnownSessionOutcomes(runs: RunRecord[]): void {
  if (
    runs.some(
      (run) =>
        Object.values(run.invocations).some(requiresOutcomeReview) ||
        run.fileChanges?.some((change) => change.status === 'restoring'),
    )
  )
    throw new Error(
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
export function sessionCorrections(store: FileSessionStore, runs: RunRecord[]): ChatMessage[] {
  const fileMessages: ChatMessage[] = [];
  const facts = runs.flatMap((run) => {
    const events = store.history(run.id, 0);
    const restorations = new Map<string, ChatMessage>();
    for (const event of events) {
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
    fileMessages.push(...restorations.values());
    const resolved = new Set(
      events
        .filter((event) => event.type === 'tool.human_resolved')
        .map((event) => z.object({ invocationId: z.string() }).parse(event.payload).invocationId),
    );
    return [...resolved].flatMap((invocationId) => {
      const invocation = run.invocations[invocationId];
      if (!invocation || !['succeeded', 'error'].includes(invocation.status)) return [];
      return [
        {
          runId: run.id,
          tool: invocation.call.name,
          callId: invocation.call.id,
          status: invocation.status,
          result: invocation.result,
        },
      ];
    });
  });
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
