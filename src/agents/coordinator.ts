import type { FileSessionStore } from '../sessions/store.js';
import type { ToolCall } from '../providers/types.js';
import { UnknownOutcomeError } from '../runtime/executor.js';
import { abort, id, message } from '../shared/primitives.js';
import { checkDelegation, newAgent } from './service.js';

type ExecuteAgent = (runId: string, agentId: string, signal: AbortSignal) => Promise<void>;

/** Владеет дочерними задачами и передаёт результаты между ролями. */
export class AgentCoordinator {
  private readonly tasks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: FileSessionStore,
    private readonly executeAgent: ExecuteAgent,
  ) {}

  async waitForRun(runId: string): Promise<void> {
    const tasks = [...this.tasks.entries()]
      .filter(([key]) => key.startsWith(runId + ':'))
      .map(([, task]) => task);
    await Promise.allSettled(tasks);
  }

  forgetRun(runId: string): void {
    for (const key of this.tasks.keys()) {
      if (key.startsWith(runId + ':')) this.tasks.delete(key);
    }
  }

  private spawn(runId: string, agentId: string, signal: AbortSignal): Promise<void> {
    const key = runId + ':' + agentId;
    const existing = this.tasks.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const task = this.executeAgent(runId, agentId, controller.signal)
      .catch(async (error) => {
        controller.abort();
        const descendants: string[] = [];
        const collect = (parent: string): void => {
          for (const child of this.store.get(runId).agents[parent]!.children) {
            descendants.push(child);
            collect(child);
          }
        };
        collect(agentId);
        await Promise.allSettled(descendants.map((child) => this.tasks.get(runId + ':' + child)));
        if (
          error instanceof UnknownOutcomeError ||
          Object.values(this.store.get(runId).invocations).some(
            (invocation) =>
              descendants.includes(invocation.agentId) && invocation.status === 'unknown',
          )
        )
          throw new UnknownOutcomeError(message(error));
        await this.store.mutate(
          runId,
          'agent.failed',
          { agentId, error: message(error) },
          (state) => {
            state.agents[agentId]!.status = signal.aborted ? 'cancelled' : 'failed';
            state.agents[agentId]!.error = message(error);
          },
        );
      })
      .finally(() => signal.removeEventListener('abort', cancel));
    void task.catch(() => undefined);
    this.tasks.set(key, task);
    return task;
  }
  async childResult(
    runId: string,
    parentId: string,
    childId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const run = this.store.get(runId);
    const child = run.agents[childId];
    if (!child || child.parentId !== parentId)
      throw new Error('Only your own child agents may be awaited');
    if (!['completed', 'failed'].includes(child.status)) await this.spawn(runId, childId, signal);
    abort(signal);
    const current = this.store.get(runId).agents[childId]!;
    // Получение результата и его включение в историю — разные шаги. Отметку ставит цикл вместе с сообщением.
    return {
      agentId: childId,
      status: current.status,
      result: current.result,
      error: current.error,
      artifacts: (this.store.get(runId).artifacts ?? []).filter((item) => item.agentId === childId),
    };
  }
  async handleToolCall(
    runId: string,
    agentId: string,
    call: ToolCall,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (call.name === 'agents.await')
      return this.childResult(runId, agentId, args.agentId as string, signal);
    if (call.name === 'agents.delegate') {
      const childId = id();
      await this.store.mutate(runId, 'agent.delegated', { agentId, childId }, (state) => {
        const parent = state.agents[agentId]!;
        checkDelegation(state, parent, args.role as string);
        const child = newAgent(
          args.role as string,
          args.task as string,
          parent,
          args.context as string,
        );
        child.id = childId;
        state.agents[childId] = child;
        parent.children.push(childId);
      });
      this.spawn(runId, childId, signal);
      return { agentId: childId };
    }
    if (call.name === 'agents.handoff') {
      await this.store.mutate(runId, 'agent.handoff', { agentId, role: args.role }, (state) => {
        const current = state.agents[agentId]!;
        if (!Object.hasOwn(state.config.value.roles, args.role as string))
          throw new Error('Unknown handoff role');
        if (
          current.children.some(
            (child) => !['completed', 'failed'].includes(state.agents[child]!.status),
          )
        )
          throw new Error('Finish child agents before handoff');
        if (state.handoffs >= state.config.value.limits.handoffs)
          throw new Error('Handoff budget exhausted');
        state.handoffs++;
        current.authorityRoles = [
          ...new Set([...current.authorityRoles, current.role, args.role as string]),
        ];
        current.role = args.role as string;
      });
      return { role: args.role, reason: args.reason };
    }
    throw new Error('Unknown control tool');
  }
}
