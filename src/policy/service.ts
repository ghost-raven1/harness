import { minimatch } from 'minimatch';
import type { Config, Decision, PermissionRule } from '../configuration/schema.js';
import type { RunRecord, AgentState, Approval } from '../sessions/types.js';
import type { ToolCall } from '../providers/types.js';
import { hash, id, abort } from '../shared/primitives.js';
import type { FileSessionStore } from '../sessions/store.js';

/** Объединяет решения с приоритетом запрета, затем запроса разрешения. */
function combine(decisions: Decision[]): Decision {
  return decisions.includes('deny') ? 'deny' : decisions.includes('ask') ? 'ask' : 'allow';
}

/** Допускает разрешение без начатого вызова, включая старые записи о преждевременном списании. */
function availableApproval(run: RunRecord, approval: Approval): boolean {
  return (
    approval.status === 'allowed' ||
    // Совместимость со старым журналом: разрешение списано, но начало эффекта ещё не записано.
    (approval.status === 'consumed' &&
      !Object.hasOwn(run.invocations, approval.agentId + ':' + approval.callId))
  );
}
/** Применяет совпавшие правила инструмента и аргументов либо решение по умолчанию. */
function evaluate(
  rules: PermissionRule[],
  fallback: Decision,
  tool: string,
  args: Record<string, unknown>,
): Decision {
  const matching = rules.filter(
    (rule) =>
      minimatch(tool, rule.tool) &&
      Object.entries(rule.args).every(
        ([key, pattern]) =>
          typeof args[key] === 'string' && minimatch(args[key] as string, pattern, { dot: true }),
      ),
  );
  return matching.length ? combine(matching.map((rule) => rule.decision)) : fallback;
}
export class PolicyService {
  /** Показывает условно доступные инструменты; точные аргументы проверяются при исполнении. */
  canAdvertise(
    config: Config,
    agent: Pick<AgentState, 'authorityRoles' | 'role'>,
    tool: string,
  ): boolean {
    const possible = (rules: PermissionRule[], fallback: Decision): boolean => {
      const matches = rules.filter((rule) => minimatch(tool, rule.tool));
      if (matches.some((rule) => rule.decision === 'deny' && !Object.keys(rule.args).length))
        return false;
      return fallback !== 'deny' || matches.some((rule) => rule.decision !== 'deny');
    };
    return (
      possible(config.policy.rules, config.policy.default) &&
      [...new Set([...agent.authorityRoles, agent.role])].every((role) =>
        possible(config.roles[role]?.permissions ?? [], 'deny'),
      )
    );
  }
  /** Пересекает глобальную политику с правами, унаследованными веткой. */
  decide(
    config: Config,
    agent: Pick<AgentState, 'authorityRoles' | 'role'>,
    tool: string,
    args: Record<string, unknown>,
  ): Decision {
    const decisions = [evaluate(config.policy.rules, config.policy.default, tool, args)];
    for (const role of new Set([...agent.authorityRoles, agent.role])) {
      decisions.push(evaluate(config.roles[role]?.permissions ?? [], 'deny', tool, args));
    }
    return combine(decisions);
  }
  /** Привязывает разрешение к вызову, роли, унаследованным правам и снимку конфигурации. */
  binding(run: RunRecord, agent: AgentState, call: ToolCall): string {
    return hash({
      run: run.id,
      agent: agent.id,
      role: agent.role,
      authority: agent.authorityRoles,
      call: call.id,
      name: call.name,
      args: call.arguments,
      config: run.config.hash,
    });
  }
}
/** Однократное разрешение человека на конкретный вызов и его аргументы. */
export interface ApprovalService {
  request(runId: string, agentId: string, call: ToolCall, signal: AbortSignal): Promise<boolean>;
  resolve(approvalId: string, allow: boolean): Promise<void>;
}
export class FileApprovalService implements ApprovalService {
  private readonly waiters = new Map<string, () => void>();
  constructor(
    private readonly store: FileSessionStore,
    private readonly policy: PolicyService,
  ) {}
  /** Сохраняет запрос человеку и ждёт решения или отмены, повторно проверяя привязку. */
  async request(
    runId: string,
    agentId: string,
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<boolean> {
    abort(signal);
    const run = this.store.get(runId);
    const agent = run.agents[agentId]!;
    const binding = this.policy.binding(run, agent, call);
    let approval = Object.values(run.approvals).find((item) => item.binding === binding);
    if (!approval) {
      approval = {
        id: id(),
        runId,
        agentId,
        callId: call.id,
        binding,
        tool: call.name,
        args: JSON.parse(call.arguments),
        reason: 'Policy requires human approval',
        status: 'pending',
      };
      const item = approval;
      await this.store.mutate(runId, 'approval.requested', { approvalId: item.id }, (state) => {
        state.approvals[item.id] = item;
        state.agents[agentId]!.status = 'waiting';
        state.status = 'awaiting_approval';
      });
    }
    const approvalId = approval.id;
    while (this.store.get(runId).approvals[approvalId]!.status === 'pending') {
      abort(signal);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiters.delete(approvalId);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        this.waiters.set(approvalId, wake);
        signal.addEventListener('abort', wake, { once: true });
        if (signal.aborted || this.store.get(runId).approvals[approvalId]!.status !== 'pending')
          wake();
      });
    }
    abort(signal);
    const current = this.store.get(runId);
    const granted = current.approvals[approvalId]!;
    if (this.policy.binding(current, current.agents[agentId]!, call) !== granted.binding)
      throw new Error('Approval binding changed');
    return availableApproval(current, granted);
  }

  /** Расходует разрешение внутри той же записи журнала, что и tool.started. */
  consume(run: RunRecord, agentId: string, call: ToolCall): void {
    const agent = run.agents[agentId]!;
    const binding = this.policy.binding(run, agent, call);
    const approval = Object.values(run.approvals).find((item) => item.binding === binding);
    if (!approval || !availableApproval(run, approval))
      throw new Error('Approval is not available for this invocation');
    approval.status = 'consumed';
    agent.status = 'running';
    run.status = Object.values(run.approvals).some((item) => item.status === 'pending')
      ? 'awaiting_approval'
      : 'running';
  }
  /** Сохраняет однократное решение человека и пробуждает ожидающий вызов. */
  async resolve(approvalId: string, allow: boolean, previewToken?: string): Promise<void> {
    const run = this.store.list().find((item) => item.approvals[approvalId]);
    if (!run) throw new Error('Unknown approval');
    await this.store.mutate(run.id, 'approval.decided', { approvalId, allow }, (state) => {
      const approval = state.approvals[approvalId]!;
      if (approval.status !== 'pending') throw new Error('Approval already resolved');
      if (state.status === 'cancelled') throw new Error('Run cancelled');
      approval.status = allow ? 'allowed' : 'denied';
      if (previewToken) approval.previewToken = previewToken;
    });
    this.waiters.get(approvalId)?.();
  }
  /** Возвращает нерешённые запросы разрешений из работающих и приостановленных задач. */
  pending(): Approval[] {
    return this.store
      .list()
      .filter((run) => ['running', 'awaiting_approval', 'paused'].includes(run.status))
      .flatMap((run) => Object.values(run.approvals).filter((a) => a.status === 'pending'));
  }
}
