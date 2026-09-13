import type { EvaluationCase } from '../configuration/schema.js';
import type { ToolCall } from '../providers/types.js';
import type { EvaluationReport, EvaluationResult } from './types.js';
import { stable } from '../shared/primitives.js';

export const EVALUATION_REPETITIONS = 3;

/** Проверяет ответ по ожиданиям автора, не обращаясь к другой модели. */
export function matchesExpectedResult(
  test: EvaluationCase,
  text: string,
  calls: ToolCall[],
): boolean {
  const requiredTextPresent = test.expect.includes.every((fragment) => text.includes(fragment));
  const forbiddenTextAbsent = test.expect.excludes.every((fragment) => !text.includes(fragment));
  const expectedCallsPresent = test.expect.calls.every((expected) =>
    calls.some((call) => {
      if (call.name !== expected.name) return false;
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      return Object.entries(expected.args ?? {}).every(
        ([key, value]) => stable(args[key]) === stable(value),
      );
    }),
  );
  return requiredTextPresent && forbiddenTextAbsent && expectedCallsPresent;
}

/** Принимает выпуск только при устойчивом улучшении и отсутствии новых регрессий. */
export function decideEvaluation(
  suite: EvaluationCase[],
  results: EvaluationResult[],
): Pick<EvaluationReport, 'passed' | 'reason'> {
  /** Считает успешные повторы одного случая для сравниваемого варианта. */
  const countPassed = (caseId: string, variant: EvaluationResult['variant']): number =>
    results.filter(
      (result) => result.caseId === caseId && result.variant === variant && result.passed,
    ).length;

  const policyViolation = results.some(
    (result) => result.variant === 'candidate' && result.detail.startsWith('CONTRACT:'),
  );
  if (policyViolation) return { passed: false, reason: 'Policy or tool contract violation' };

  const regression = suite.some(
    (test) => countPassed(test.id, 'candidate') < countPassed(test.id, 'baseline'),
  );
  if (regression) return { passed: false, reason: 'Held-out regression' };

  const targetImproved = suite.some(
    (test) =>
      test.kind === 'target' &&
      countPassed(test.id, 'candidate') === EVALUATION_REPETITIONS &&
      countPassed(test.id, 'baseline') < EVALUATION_REPETITIONS,
  );
  if (!targetImproved) return { passed: false, reason: 'No repeatable target improvement' };

  return { passed: true, reason: 'No held-out regressions; target improved in all three runs' };
}
