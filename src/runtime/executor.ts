import type { ExecutionObserver } from '../insights/ports.js';
import { observeAgent } from './observations.js';
import { ApplicationError } from '../shared/application-error.js';
import type { SessionStore } from '../sessions/ports.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolScheduler } from '../tools/scheduler.js';
import type { FileApprovalService, PolicyService } from '../policy/service.js';
import type { ToolCall } from '../providers/types.js';
import type { ToolInvocation, RunRecord } from '../sessions/types.js';
import { planningToolAllowed } from '../sessions/project-run.js';
import { RunPausedError } from '../shared/run-pause.js';
import { abort, deadline, message } from '../shared/primitives.js';
import { delegateSchema, awaitSchema, handoffSchema } from '../agents/service.js';
import { ToolOutcomeUnknownError } from '../tools/errors.js';

/** Неизвестный результат требует проверки человеком до дальнейшего исполнения. */
export class UnknownOutcomeError extends ApplicationError {
  constructor(message: string) {
    super('UNKNOWN_OUTCOME', message);
    this.name = 'UnknownOutcomeError';
  }
}
export type ControlHandler = (
  runId: string,
  agentId: string,
  call: ToolCall,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
/** Пауза и владение папкой проверяются у границы начала эффекта. */
export interface ExecutionControl {
  checkpoint(runId: string): void;
  waitingSignal(runId: string, signal: AbortSignal): AbortSignal;
  assertWrite(run: RunRecord): void;
}
/** Проверяет вызов, записывает начало до эффекта и сохраняет результат с исходным ID. */
export class InvocationExecutor {
  private control: ExecutionControl = {
    checkpoint: () => undefined,
    waitingSignal: (_runId, signal) => signal,
    assertWrite: () => undefined,
  };
  constructor(
    private readonly store: SessionStore,
    private readonly registry: ToolRegistry,
    private readonly scheduler: ToolScheduler,
    private readonly policy: PolicyService,
    private readonly approvals: FileApprovalService,
    private readonly observer?: ExecutionObserver,
  ) {}
  /** Подключает жизненный цикл runtime, оставляя исполнитель независимым от проектов. */
  setExecutionControl(control: ExecutionControl): void {
    this.control = control;
  }
  /** Проверяет схему, права и сохранённый исход перед выполнением одного вызова. */
  async execute(
    runId: string,
    agentId: string,
    call: ToolCall,
    signal: AbortSignal,
    control: ControlHandler,
  ): Promise<string> {
    const key = agentId + ':' + call.id;
    const cached = this.store.get(runId).invocations[key];
    if (cached?.status === 'unknown')
      throw new UnknownOutcomeError('Resolve unknown invocation in CLI: ' + key);
    if (cached && cached.status !== 'started')
      return cached.result ?? JSON.stringify({ error: cached.error });
    const run = this.store.get(runId);
    const agent = run.agents[agentId]!;
    const observation = observeAgent(this.observer, run, agent);
    const details = { invocationId: key };
    const isControl = call.name.startsWith('agents.');
    let effect: ToolInvocation['effect'] = isControl ? 'control' : 'read';
    let started = false;
    try {
      abort(signal);
      this.control.checkpoint(runId);
      if (run.project?.kind === 'planning' && !planningToolAllowed(call.name))
        return this.finish(runId, agentId, call, effect, 'denied', {
          error: 'PLANNING_READ_ONLY',
          tool: call.name,
        });
      if (
        run.project?.kind === 'checks' &&
        (call.name !== 'process.exec' ||
          !run.projectChecks?.some(
            (check) =>
              check.id === call.id &&
              check.name === call.name &&
              check.arguments === call.arguments,
          ))
      )
        return this.finish(runId, agentId, call, effect, 'denied', {
          error: 'CHECK_NOT_CONFIGURED',
          tool: call.name,
        });
      let args: unknown = JSON.parse(call.arguments);
      if (isControl) {
        if (call.name === 'agents.delegate') args = delegateSchema.parse(args);
        else if (call.name === 'agents.await') args = awaitSchema.parse(args);
        else if (call.name === 'agents.handoff') args = handoffSchema.parse(args);
        else throw new Error('Unknown control tool');
      } else {
        this.registry.validate(call.name, args);
        effect = this.registry.get(call.name).definition.effect;
      }
      const decision = this.policy.decide(
        run.config.value,
        agent,
        call.name,
        args as Record<string, unknown>,
      );
      // Решение человека не занимает общую очередь инструментов других задач и ролей.
      if (decision === 'deny')
        return this.finish(runId, agentId, call, effect, 'denied', {
          error: 'POLICY_DENIED',
          tool: call.name,
        });
      let allowed = true;
      if (decision === 'ask') {
        const phase = observation.begin('approval', details);
        try {
          allowed = await this.approvals.request(
            runId,
            agentId,
            call,
            this.control.waitingSignal(runId, signal),
          );
        } catch (error) {
          phase.end(signal.aborted ? 'cancelled' : 'failed');
          throw error;
        } finally {
          phase.end();
        }
      }
      if (!allowed) {
        return this.finish(runId, agentId, call, effect, 'denied', {
          error: 'HUMAN_DENIED',
          tool: call.name,
        });
      }
      const work = async (): Promise<string> => {
        abort(signal);
        this.control.checkpoint(runId);
        if (effect === 'write') this.control.assertWrite(this.store.get(runId));
        await this.store.mutate(
          runId,
          'tool.started',
          { agentId, tool: call.name, invocationId: key },
          (state) => {
            abort(signal);
            this.control.checkpoint(runId);
            if (effect === 'write') this.control.assertWrite(state);
            if (decision === 'ask') this.approvals.consume(state, agentId, call);
            state.invocations[key] = {
              id: key,
              agentId,
              role: agent.role,
              call,
              effect,
              status: 'started',
              startedAt: new Date().toISOString(),
            };
          },
        );
        abort(signal);
        started = true;
        const timeout = deadline(signal, run.config.value.tools.timeoutMs);
        const phase = observation.begin('tool.execute', details);
        let resultReceived = false;
        try {
          // Ожидание подзадач использует отмену запуска и не удерживает блокировку инструментов.
          const result = isControl
            ? await control(runId, agentId, call, args as Record<string, unknown>, signal)
            : await this.registry.get(call.name).execute(args as Record<string, unknown>, {
                runId,
                invocationId: key,
                previewToken: Object.values(this.store.get(runId).approvals).find(
                  (item) =>
                    item.agentId === agentId &&
                    item.callId === call.id &&
                    item.status === 'consumed',
                )?.previewToken,
                workspace: run.workspace,
                config: run.config.value,
                signal: timeout.signal,
              });
          resultReceived = true;
          if (!isControl && timeout.signal.aborted)
            throw new Error('Tool timed out; outcome may be unknown');
          const failed =
            result &&
            typeof result === 'object' &&
            (('isError' in result && result.isError === true) ||
              ('exitCode' in result && result.exitCode !== 0));
          const packed = await this.finish(
            runId,
            agentId,
            call,
            effect,
            failed ? 'error' : 'succeeded',
            result,
          );
          phase.end(failed ? 'failed' : 'completed');
          return packed;
        } catch (error) {
          phase.end(signal.aborted ? 'cancelled' : 'failed');
          // Журнал мог сохраниться до отказа снимка. Подтверждённый исход уже нельзя понижать до ошибки.
          const saved = this.store.get(runId).invocations[key];
          if (resultReceived && saved && ['succeeded', 'error'].includes(saved.status))
            return saved.result!;
          if (
            effect === 'write' &&
            (resultReceived || timeout.signal.aborted || error instanceof ToolOutcomeUnknownError)
          ) {
            return this.markUnknown(runId, agentId, call, error);
          }
          throw error;
        } finally {
          phase.end();
          timeout.close();
        }
      };
      if (isControl) return await work();
      const queued = observation.begin('tool.queue', details);
      try {
        return await this.scheduler.schedule(
          effect as 'read' | 'write',
          () => {
            queued.end();
            return work();
          },
          this.control.waitingSignal(runId, signal),
        );
      } finally {
        queued.end(signal.aborted ? 'cancelled' : 'failed');
      }
    } catch (error) {
      if (error instanceof UnknownOutcomeError) throw error;
      if (
        error instanceof RunPausedError ||
        (!started && !signal.aborted && this.store.get(runId).pauseRequested)
      ) {
        // agents.await только ожидает: его незавершённую запись можно повторить без нового эффекта.
        if (started && call.name === 'agents.await')
          await this.store.mutate(runId, 'tool.deferred', { invocationId: key }, (state) => {
            delete state.invocations[key];
          });
        throw new RunPausedError();
      }
      if (started && effect === 'write' && signal.aborted) {
        return this.markUnknown(runId, agentId, call, error);
      }
      return this.finish(runId, agentId, call, effect, signal.aborted ? 'cancelled' : 'error', {
        error: message(error),
      });
    }
  }

  /** Ошибка сохранения результата не разрешает автоматически повторить побочный эффект. */
  private async markUnknown(
    runId: string,
    agentId: string,
    call: ToolCall,
    error: unknown,
  ): Promise<never> {
    try {
      await this.finish(runId, agentId, call, 'write', 'unknown', {
        error: 'Не удалось подтвердить результат операции.',
        outcome: 'unknown',
      });
    } finally {
      throw new UnknownOutcomeError(
        'Tool outcome unknown: ' + agentId + ':' + call.id + '. ' + message(error),
      );
    }
  }

  /** Сохраняет статус и результат вызова, вынося большой текст в артефакт. */
  async finish(
    runId: string,
    agentId: string,
    call: ToolCall,
    effect: ToolInvocation['effect'],
    status: ToolInvocation['status'],
    value: unknown,
  ): Promise<string> {
    const run = this.store.get(runId);
    let result = JSON.stringify(value ?? null);
    let artifactId: string | undefined;
    const max = run.config.value.tools.resultBytes;
    if (Buffer.byteLength(result) > max) {
      artifactId = await this.store.artifact(runId, result);
      result = JSON.stringify({
        truncated: true,
        artifactId,
        preview: Buffer.from(result).subarray(0, max).toString('utf8'),
        ...(value &&
        typeof value === 'object' &&
        'stdoutTruncated' in value &&
        value.stdoutTruncated === true
          ? { stdoutTruncated: true }
          : {}),
        ...(value &&
        typeof value === 'object' &&
        'stderrTruncated' in value &&
        value.stderrTruncated === true
          ? { stderrTruncated: true }
          : {}),
      });
    }
    const key = agentId + ':' + call.id;
    await this.store.mutate(
      runId,
      'tool.' + status,
      { invocationId: key, agentId, tool: call.name },
      (state) => {
        if (status === 'cancelled')
          for (const approval of Object.values(state.approvals)) {
            if (
              approval.agentId === agentId &&
              approval.callId === call.id &&
              approval.status === 'pending'
            )
              approval.status = 'cancelled';
          }
        if (artifactId) (state.artifacts ??= []).push({ id: artifactId, agentId, callId: call.id });
        state.invocations[key] = {
          id: key,
          agentId,
          role: state.invocations[key]?.role ?? state.agents[agentId]!.role,
          call,
          effect,
          status,
          result,
          startedAt: state.invocations[key]?.startedAt ?? new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          ...(call.name === 'process.exec' &&
          value &&
          typeof value === 'object' &&
          'exitCode' in value &&
          (value.exitCode === null ||
            (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
            ? { exitCode: value.exitCode as number | null }
            : {}),
        };
        const current = state.agents[agentId]!;
        if (
          current.status === 'waiting' &&
          !Object.values(state.approvals).some(
            (a) => a.agentId === agentId && a.status === 'pending',
          )
        )
          current.status = 'running';
        if (
          state.status === 'awaiting_approval' &&
          !Object.values(state.approvals).some((a) => a.status === 'pending')
        )
          state.status = 'running';
      },
    );
    return result;
  }
}
