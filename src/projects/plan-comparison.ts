import { hash } from '../shared/primitives.js';
import type { ProjectPlan } from './types.js';
import type { PlanChange } from './plan-schema.js';

/** Сопоставляет устойчивые идентификаторы, сохраняя различия порядка и буквальных аргументов. */
export function comparePlanValues(
  before: ProjectPlan | undefined,
  after: ProjectPlan,
): PlanChange[] {
  const changes: PlanChange[] = [];
  const changed = (
    field: string,
    left: unknown,
    right: unknown,
    stageId?: string,
    checkId?: string,
  ) => {
    if (hash(left) !== hash(right))
      changes.push({
        kind: field.endsWith('.order') ? 'reordered' : 'changed',
        field,
        before: left,
        after: right,
        stageId,
        checkId,
      });
  };
  if (!before) {
    changes.push({ kind: 'added', field: 'maxCorrections', after: after.maxCorrections });
    changes.push({ kind: 'added', field: 'fixBaselineFailures', after: after.fixBaselineFailures });
  } else {
    changed('maxCorrections', before.maxCorrections, after.maxCorrections);
    changed('fixBaselineFailures', before.fixBaselineFailures, after.fixBaselineFailures);
    changed(
      'stages.order',
      before.stages.map((stage) => stage.id),
      after.stages.map((stage) => stage.id),
    );
  }
  const previous = new Map(before?.stages.map((stage) => [stage.id, stage]));
  const next = new Map(after.stages.map((stage) => [stage.id, stage]));
  for (const stage of before?.stages ?? [])
    if (!next.has(stage.id))
      changes.push({ kind: 'removed', field: 'stage', stageId: stage.id, before: stage });
  for (const stage of after.stages) {
    const old = previous.get(stage.id);
    if (!old) {
      changes.push({ kind: 'added', field: 'stage', stageId: stage.id, after: stage });
      continue;
    }
    for (const field of [
      'title',
      'task',
      'role',
      'dependsOn',
      'expectedResult',
      'requiredTools',
    ] as const)
      changed(field, old[field], stage[field], stage.id);
    const left = old.verification,
      right = stage.verification;
    changed('verification.kind', left.kind, right.kind, stage.id);
    if (left.kind !== right.kind) {
      changes.push({
        kind: 'changed',
        field: 'verification',
        stageId: stage.id,
        before: left,
        after: right,
      });
    } else if (left.kind === 'manual' && right.kind === 'manual') {
      changed('verification.instructions', left.instructions, right.instructions, stage.id);
    } else if (left.kind === 'commands' && right.kind === 'commands') {
      changed(
        'checks.order',
        left.checks.map((check) => check.id),
        right.checks.map((check) => check.id),
        stage.id,
      );
      const oldChecks = new Map(left.checks.map((check) => [check.id, check]));
      const newChecks = new Set(right.checks.map((check) => check.id));
      for (const check of left.checks)
        if (!newChecks.has(check.id))
          changes.push({
            kind: 'removed',
            field: 'check',
            stageId: stage.id,
            checkId: check.id,
            before: check,
          });
      for (const check of right.checks) {
        const oldCheck = oldChecks.get(check.id);
        if (!oldCheck) {
          changes.push({
            kind: 'added',
            field: 'check',
            stageId: stage.id,
            checkId: check.id,
            after: check,
          });
          continue;
        }
        for (const field of ['title', 'command', 'args'] as const)
          changed('check.' + field, oldCheck[field], check[field], stage.id, check.id);
      }
    }
  }
  return changes;
}
