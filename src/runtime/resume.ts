import type { SessionStore } from '../sessions/ports.js';
import type { RunRecord } from '../sessions/types.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import { ApplicationError } from '../shared/application-error.js';
import { requiresOutcomeReview } from '../sessions/invocations.js';
import {
  assertKnownSessionOutcomes,
  missingSessionCorrections,
  sessionCorrections,
} from '../sessions/continuation.js';
import { serviceFingerprint } from './run-factory.js';
import { seedProjectContext } from './project-context.js';

/** Проверяет подтверждённые исходы и сохраняет продолжение с исходными настройками запуска. */
export async function prepareResume(
  store: SessionStore,
  previous: RunRecord,
  initialConfig: ConfigSnapshot,
): Promise<void> {
  const runId = previous.id;
  await seedProjectContext(store, runId);
  const sessionRuns = store.catalog(true).filter((run) => run.sessionId === previous.sessionId);
  const revision = store.sessionRevision(previous.sessionId);
  const corrections = await sessionCorrections(store, sessionRuns);
  if (serviceFingerprint(previous.config.value) !== serviceFingerprint(initialConfig.value)) {
    throw new Error('Resume requires the original MCP, concurrency and learning service settings');
  }
  await store.mutate(runId, 'run.resumed', {}, (state) => {
    if (state.status !== 'paused') throw new Error('Only paused runs can be resumed');
    if (Object.values(state.invocations).some(requiresOutcomeReview))
      throw new ApplicationError('UNKNOWN_OUTCOME', 'Resolve unknown invocations before resuming');
    if (state.fileChanges?.some((change) => change.status === 'restoring'))
      throw new ApplicationError(
        'UNKNOWN_OUTCOME',
        'Сначала проверьте результат прерванного восстановления файла.',
      );
    if (revision !== store.sessionRevision(state.sessionId))
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Состояние беседы изменилось. Повторите продолжение.',
      );
    assertKnownSessionOutcomes(sessionRuns);
    if (state.providerPause?.retryAt && Date.parse(state.providerPause.retryAt) > Date.now())
      throw new Error(
        'Провайдер просит подождать до ' +
          state.providerPause.retryAt +
          '. Затем продолжите задачу.',
      );
    state.status = 'running';
    delete state.providerPause;
    state.iterationLimit ??= state.config.value.limits.turns;
    state.iterationStart = state.turns;
    delete state.pauseReason;
    delete state.pauseRequested;
    delete state.error;
    for (const agent of Object.values(state.agents))
      if (agent.status !== 'completed' && agent.status !== 'failed') {
        let parent = agent.parentId ? state.agents[agent.parentId] : undefined;
        while (parent && !['completed', 'failed'].includes(parent.status))
          parent = parent.parentId ? state.agents[parent.parentId] : undefined;
        if (parent) {
          // Завершённая ветка не запустит потомков повторно через agents.await.
          agent.status = 'cancelled';
          continue;
        }
        // Сводка дополняется отдельно: pending-вызовы ещё не имеют сообщений с результатами.
        const missing = missingSessionCorrections(corrections, agent);
        if (missing.length)
          agent.summary = [agent.summary, ...missing.map((item) => item.content)]
            .filter(Boolean)
            .join('\n\n');
        agent.status = 'running';
        delete agent.error;
      }
  });
}
