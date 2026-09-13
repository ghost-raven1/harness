import type { FileSessionStore } from '../sessions/store.js';
import type { RunRecord, AgentState } from '../sessions/types.js';
import type { ModelProvider, ToolDefinition } from '../providers/types.js';
import { ProviderError } from '../providers/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PolicyService } from '../policy/service.js';
import type { ContextService } from '../context/service.js';
import { estimate } from '../context/service.js';
import type { AgentCoordinator } from '../agents/coordinator.js';
import { configuredControlDefinitions } from '../agents/service.js';
import {
  needsPlanning,
  planningDefinition,
  planningInstruction,
  validatePlan,
  plannedCalls,
} from '../agents/planning.js';
import type { CoordinationPlan } from '../agents/planning.js';
import { InvocationExecutor, UnknownOutcomeError } from './executor.js';
import { IterationLimitError, iterationProgress } from './iterations.js';
import { abort, message } from '../shared/primitives.js';
import { deliverMessages, hasPendingMessages } from './messages.js';

interface AgentLoopServices {
  store: FileSessionStore;
  provider: ModelProvider;
  context: ContextService;
  registry: ToolRegistry;
  policy: PolicyService;
  executor: InvocationExecutor;
  agents: AgentCoordinator;
  providerFor(runId: string): ModelProvider;
  stopRun(runId: string, reason?: Error): void;
}

/** Исполняет цикл одной роли: контекст, модель, инструменты и завершение хода. */
export class AgentLoop {
  constructor(private readonly services: AgentLoopServices) {}
  /** Выбирает инструменты, доступные роли с учётом всей цепочки полномочий. */
  private definitions(run: RunRecord, agent: AgentState): ToolDefinition[] {
    return [
      ...this.services.registry.definitions(),
      ...configuredControlDefinitions(run.config.value),
    ].filter((tool) =>
      // Ограничения аргументов повторно проверяются для конкретного вызова.
      this.services.policy.canAdvertise(run.config.value, agent, tool.name),
    );
  }
  /** Ведёт одну ветку до результата, сохраняя обмены и проверяя общие пределы. */
  async run(runId: string, agentId: string, signal: AbortSignal): Promise<void> {
    let forcedCompaction = false;
    while (true) {
      abort(signal);
      let run = this.services.store.get(runId);
      let agent = run.agents[agentId]!;
      const root = agentId === run.rootAgentId;
      if (agent.status === 'completed' && !(root && hasPendingMessages(run))) return;
      if (agent.pending?.length) {
        await this.completePendingCalls(run, agent, signal);
        continue;
      }
      if (root) {
        run = await deliverMessages(this.services.store, run);
        agent = run.agents[agentId]!;
      }
      const planning = needsPlanning(run, agent);
      if (planning && run.coordination!.attempts >= 2)
        throw new Error(
          'Модель дважды вернула неверный план работы. Проверьте поддержку инструментов выбранного профиля или задайте coordination: manual в конфигурации.',
        );
      await this.services.store.mutate(
        runId,
        'model.requested',
        { agentId, profile: this.services.context.profile(run, agent).id },
        (state) => {
          abort(signal);
          const progress = iterationProgress(state);
          if (progress.used >= progress.limit) {
            const error = new IterationLimitError(progress.limit);
            this.services.stopRun(runId, error);
            throw error;
          }
          state.turns++;
        },
      );
      const tools = planning ? [planningDefinition(run)] : this.definitions(run, agent);
      if (forcedCompaction || this.services.context.needsCompaction(run, agent, tools)) {
        run = await this.compactContext(run, agent, signal);
        agent = run.agents[agentId]!;
      }
      this.services.context.assertFits(run, agent, tools);
      const messages = this.services.context.build(run, agent, tools);
      if (planning) messages[0]!.content += '\n\n' + planningInstruction(run);
      const { profile } = this.services.context.profile(run, agent);
      if (estimate(messages) + estimate(tools) > profile.contextTokens - profile.outputTokens)
        throw new Error(
          'CONTEXT_LIMIT: configured roles and routing instructions do not fit the selected model context',
        );
      let output;
      const progress = await this.services.store.output.begin(runId, agentId, agent.role);
      try {
        output = await this.services.providerFor(runId).generate({
          profile: this.services.context.profile(run, agent).profile,
          messages,
          tools,
          signal,
          onProgress: progress.progress,
        });
      } catch (error) {
        await progress.finish();
        if (error instanceof ProviderError && error.contextOverflow && !forcedCompaction) {
          forcedCompaction = true;
          continue;
        }
        throw error;
      }
      await progress.finish(output);
      if (output.finish === 'length')
        throw new Error('Model output token limit reached; no tool call was executed');
      forcedCompaction = false;
      if (output.calls.some((call) => agent.completedCalls.includes(call.id)))
        throw new Error('Model reused an executed tool call ID');
      if (new Set(output.calls.map((call) => call.id)).size !== output.calls.length)
        throw new Error('Duplicate tool call IDs');
      abort(signal);
      if (planning) {
        await this.recordPlan(run, agent, output);
        continue;
      }
      await this.services.store.mutate(
        runId,
        'model.completed',
        { agentId, finish: output.finish, requestId: progress.requestId },
        (state) => {
          const target = state.agents[agentId]!;
          target.messages.push({
            role: 'assistant',
            content: output.text,
            ...(output.calls.length ? { toolCalls: output.calls } : {}),
            ...(output.reasoning
              ? { reasoning: output.reasoning, reasoningSignature: output.reasoningSignature }
              : {}),
            ...(output.redactedReasoning ? { redactedReasoning: output.redactedReasoning } : {}),
          });
          if (output.calls.length) target.pending = output.calls;
          state.usage.input += output.usage.input;
          state.usage.output += output.usage.output;
        },
      );
      if (output.calls.length) continue;
      if (root && hasPendingMessages(this.services.store.get(runId))) continue;
      const latest = this.services.store.get(runId).agents[agentId]!;
      const uncollected = latest.children.filter(
        (child) => !latest.collectedChildren.includes(child),
      );
      if (uncollected.length) {
        const results = await Promise.all(
          uncollected.map((child) =>
            this.services.agents.childResult(runId, agentId, child, signal),
          ),
        );
        await this.services.store.mutate(
          runId,
          'agent.children_collected',
          { agentId },
          (state) => {
            abort(signal);
            state.agents[agentId]!.messages.push({
              role: 'user',
              content: '[HARNESS: incorporate completed child results]\n' + JSON.stringify(results),
            });
            state.agents[agentId]!.collectedChildren = [
              ...new Set([...state.agents[agentId]!.collectedChildren, ...uncollected]),
            ];
          },
        );
        continue;
      }
      await this.services.store.mutate(runId, 'agent.completed', { agentId }, (state) => {
        state.agents[agentId]!.status = 'completed';
        state.agents[agentId]!.result = output.text;
      });
      return;
    }
  }

  /** Сохраняет план и все вызовы одной записью; авария не запускает планирование заново. */
  private async recordPlan(
    run: RunRecord,
    agent: AgentState,
    output: import('../providers/types.js').ModelOutput,
  ): Promise<void> {
    let plan: CoordinationPlan | undefined;
    let error: string | undefined;
    try {
      plan = validatePlan(output, run, agent, this.services.policy);
    } catch (caught) {
      error = message(caught);
    }
    const calls = plan ? plannedCalls(plan) : [];
    await this.services.store.mutate(
      run.id,
      plan ? 'agent.plan_created' : 'agent.plan_rejected',
      { agentId: agent.id, reason: plan?.reason, mode: plan?.mode, error },
      (state) => {
        const current = state.agents[agent.id]!;
        current.messages.push({
          role: 'assistant',
          content: output.text,
          ...(output.calls.length ? { toolCalls: output.calls } : {}),
          ...(output.reasoning
            ? { reasoning: output.reasoning, reasoningSignature: output.reasoningSignature }
            : {}),
          ...(output.redactedReasoning ? { redactedReasoning: output.redactedReasoning } : {}),
        });
        for (const call of output.calls) {
          current.messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(plan ? { accepted: true, plan } : { error }),
          });
          current.completedCalls.push(call.id);
        }
        state.usage.input += output.usage.input;
        state.usage.output += output.usage.output;
        if (plan) {
          state.coordination!.plan = plan;
          if (calls.length) {
            current.messages.push({
              role: 'assistant',
              content: '[HARNESS: dispatch validated plan]',
              toolCalls: calls,
            });
            current.pending = calls;
          }
        } else {
          state.coordination!.attempts++;
          current.messages.push({
            role: 'user',
            content: '[HARNESS: repair routing plan; no actions were executed]\n' + error,
          });
        }
      },
    );
  }

  /** Закрывает всю пачку вызовов и добавляет результаты в историю в исходном порядке. */
  private async completePendingCalls(
    run: RunRecord,
    agent: AgentState,
    signal: AbortSignal,
  ): Promise<void> {
    const runId = run.id;
    const agentId = agent.id;
    const pending = agent.pending!;
    const mixedHandoff =
      pending.some((call) => call.name === 'agents.handoff') && pending.length !== 1;
    const handleControl = this.services.agents.handleToolCall.bind(this.services.agents);
    const settled = await Promise.allSettled(
      pending.map(async (call) => {
        try {
          if (mixedHandoff) {
            return await this.services.executor.finish(runId, agentId, call, 'control', 'error', {
              error: 'Handoff must be the only call; no batch operation was executed',
            });
          }
          return await this.services.executor.execute(runId, agentId, call, signal, handleControl);
        } catch (error) {
          this.services.stopRun(runId);
          throw error;
        }
      }),
    );
    const failure =
      settled.find(
        (result) => result.status === 'rejected' && result.reason instanceof UnknownOutcomeError,
      ) ?? settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const results = settled.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    abort(signal);
    await this.services.store.mutate(runId, 'agent.tools_completed', { agentId }, (state) => {
      const target = state.agents[agentId]!;
      pending.forEach((call, index) => {
        target.messages.push({ role: 'tool', toolCallId: call.id, content: results[index]! });
        target.completedCalls.push(call.id);
        if (
          call.name === 'agents.await' &&
          state.invocations[agentId + ':' + call.id]?.status === 'succeeded'
        ) {
          const childId = (JSON.parse(call.arguments) as { agentId: string }).agentId;
          if (target.children.includes(childId) && !target.collectedChildren.includes(childId))
            target.collectedChildren.push(childId);
        }
      });
      delete target.pending;
    });
  }

  /** Сохраняет сжатую историю и расход только после полного ответа провайдера. */
  private async compactContext(
    run: RunRecord,
    agent: AgentState,
    signal: AbortSignal,
  ): Promise<RunRecord> {
    const runId = run.id;
    const agentId = agent.id;
    const compacted = await this.services.context.compact(
      run,
      agent,
      this.services.providerFor(runId),
      signal,
    );
    await this.services.store.mutate(runId, 'context.compacted', { agentId }, (state) => {
      state.agents[agentId]!.messages = compacted.messages;
      state.agents[agentId]!.summary = compacted.summary;
      state.usage.input += compacted.usage.input;
      state.usage.output += compacted.usage.output;
    });

    return this.services.store.get(runId);
  }
}
