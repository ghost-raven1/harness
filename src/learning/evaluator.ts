import type {
  LearningEvaluator,
  LearningCandidate,
  EvaluationReport,
  LearningStore,
} from './types.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { LearningBudget } from './budget.js';
import type { PolicyService } from '../policy/service.js';
import type { EvaluationCase } from '../configuration/schema.js';
import type { ChatMessage, ToolCall } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { hash, stable } from '../shared/primitives.js';
import {
  EVALUATION_REPETITIONS,
  decideEvaluation,
  matchesExpectedResult,
} from './evaluation-checks.js';

/** Проверяет обе версии по три раза, исполняя только тестовые инструменты. */
export class HeldOutEvaluator implements LearningEvaluator {
  constructor(
    private readonly learning: LearningStore,
    private readonly sessions: FileSessionStore,
    private readonly budget: LearningBudget,
    private readonly policy: PolicyService,
  ) {}
  async evaluate(candidate: LearningCandidate): Promise<EvaluationReport> {
    const run = this.sessions.get(candidate.sourceRunId);
    const suite = run.config.value.learning.cases.filter(
      (test) =>
        test.role === candidate.role &&
        (!test.workspace || test.workspace === candidate.workspace) &&
        (!test.profile || test.profile === candidate.profile),
    );
    const baselineVersion = this.learning.read().activeVersion;
    const suiteHash = hash(suite);
    if (
      suite.some(
        (test) =>
          test.kind === 'holdout' &&
          Object.values(run.agents).some((agent) => agent.task.trim() === test.prompt.trim()),
      )
    ) {
      throw new Error('Held-out case overlaps a source task');
    }
    const report = await this.prepareReport(candidate.id, baselineVersion, suiteHash);
    if (
      !suite.some((test) => test.kind === 'target') ||
      !suite.some((test) => test.kind === 'holdout')
    ) {
      report.passed = false;
      report.reason = 'Both target and independent held-out cases are required';
      await this.saveReport(report);
      return report;
    }
    for (const test of suite)
      for (let repetition = 0; repetition < EVALUATION_REPETITIONS; repetition++) {
        for (const variant of ['baseline', 'candidate'] as const) {
          if (
            report.results.some(
              (result) =>
                result.caseId === test.id &&
                result.variant === variant &&
                result.repetition === repetition,
            )
          )
            continue;
          const result = await this.runCase(
            candidate,
            test,
            baselineVersion,
            variant === 'candidate',
          );
          report.results.push({ caseId: test.id, variant, repetition, ...result });
          await this.saveReport(report);
        }
      }
    Object.assign(report, decideEvaluation(suite, report.results));
    await this.saveReport(report);
    return report;
  }

  private async prepareReport(
    candidateId: string,
    baselineVersion: string,
    suiteHash: string,
  ): Promise<EvaluationReport> {
    const existing = this.learning.read().reports[candidateId];
    if (existing?.baselineVersion === baselineVersion && existing.suiteHash === suiteHash) {
      return existing;
    }
    const report: EvaluationReport = { candidateId, baselineVersion, suiteHash, results: [] };
    await this.saveReport(report);
    return report;
  }

  private async saveReport(report: EvaluationReport): Promise<void> {
    const snapshot = structuredClone(report);
    await this.learning.update((state) => {
      state.reports[report.candidateId] = snapshot;
    });
  }

  private async runCase(
    candidate: LearningCandidate,
    test: EvaluationCase,
    baselineVersion: string,
    withCandidate: boolean,
  ): Promise<{ passed: boolean; detail: string }> {
    const run = this.sessions.get(candidate.sourceRunId);
    const config = run.config.value;
    const registry = new ToolRegistry();
    for (const tool of test.tools)
      registry.register({
        definition: {
          name: tool.name,
          description: tool.description,
          schema: tool.schema,
          effect: tool.effect,
        },
        async execute() {
          return tool.result;
        },
      });
    const lessons = this.learning.lessons(
      baselineVersion,
      candidate.workspace,
      candidate.role,
      candidate.profile,
    );
    if (withCandidate) lessons.push(candidate.appliesWhen + ': ' + candidate.lesson);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          config.basePrompt +
          '\n' +
          config.rules.join('\n') +
          '\n' +
          config.roles[candidate.role]!.prompt +
          '\nEnforced policy: ' +
          stable(config.policy),
      },
      { role: 'user', content: '[VERIFIED EXPERIENCE]\n' + lessons.join('\n') },
      { role: 'user', content: test.prompt },
    ];
    const calls: ToolCall[] = [];
    for (let turn = 0; turn < test.maxTurns; turn++) {
      // Уже отправленный запрос может завершиться, но отозванный урок больше не оцениваем.
      if (this.learning.read().candidates[candidate.id]?.status === 'revoked')
        throw new Error('Урок отозван; оценка остановлена');
      const output = await this.budget.generate({
        profile: config.profiles[candidate.profile]!,
        messages,
        tools: registry.definitions(),
      });
      if (output.finish === 'length') return { passed: false, detail: 'Model output truncated' };
      messages.push({
        role: 'assistant',
        content: output.text,
        ...(output.calls.length ? { toolCalls: output.calls } : {}),
      });
      if (!output.calls.length) {
        const passed = matchesExpectedResult(test, output.text, calls);
        return {
          passed,
          detail: passed ? 'Trusted assertions passed' : 'Trusted output/call assertions failed',
        };
      }
      for (const call of output.calls) {
        let args: unknown;
        try {
          args = JSON.parse(call.arguments);
          registry.validate(call.name, args);
          if (
            this.policy.decide(
              config,
              { role: candidate.role, authorityRoles: [candidate.role] },
              call.name,
              args as Record<string, unknown>,
            ) !== 'allow'
          ) {
            return { passed: false, detail: 'CONTRACT: evaluation attempted an unapproved action' };
          }
        } catch {
          return { passed: false, detail: 'CONTRACT: invalid or unavailable tool call' };
        }
        calls.push(call);
        // Здесь возвращаются только тестовые результаты; подключать реальные инструменты запрещено.
        const tool = test.tools.find((item) => item.name === call.name)!;
        messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(tool.result) });
      }
    }
    return { passed: false, detail: 'Evaluation turn budget exhausted' };
  }
}
