import type { SessionStore } from '../sessions/ports.js';
import type { InvocationExecutor } from './executor.js';
import { abort } from '../shared/primitives.js';

/** Проверяет закреплённые команды без модели и останавливается на первом неуспехе. */
export class CheckLoop {
  constructor(
    private readonly store: SessionStore,
    private readonly executor: InvocationExecutor,
    private readonly checkpoint: (runId: string) => void,
  ) {}
  /** Возобновление читает подтверждённые исходы и не запускает успешную команду повторно. */
  async run(runId: string, signal: AbortSignal): Promise<void> {
    const run = this.store.get(runId);
    const agentId = run.rootAgentId;
    const calls = run.projectChecks ?? [];
    if (!calls.length) throw new Error('Checks require configured calls');
    for (const call of calls) {
      abort(signal);
      this.checkpoint(runId);
      const result = await this.executor.execute(runId, agentId, call, signal, async () => {
        throw new Error('Checks cannot delegate or hand off');
      });
      const invocation = this.store.get(runId).invocations[agentId + ':' + call.id];
      await this.store.mutate(
        runId,
        'check.completed',
        { callId: call.id, status: invocation?.status },
        (state) => {
          const agent = state.agents[agentId]!;
          if (agent.completedCalls.includes(call.id)) return;
          agent.messages.push({ role: 'assistant', content: '', toolCalls: [call] });
          agent.messages.push({ role: 'tool', toolCallId: call.id, content: result });
          agent.completedCalls.push(call.id);
        },
      );
      if (invocation?.status !== 'succeeded') throw new Error('Проверка не пройдена: ' + call.id);
    }
    await this.store.mutate(runId, 'agent.completed', { agentId }, (state) => {
      const agent = state.agents[agentId]!;
      agent.status = 'completed';
      agent.result = 'Проверки пройдены: ' + calls.length + '.';
    });
  }
}
