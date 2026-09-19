import { ApplicationError } from '../shared/application-error.js';
import { hash } from '../shared/primitives.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ProjectPlan, ProjectRecord, VersionedPlan } from './types.js';
import { assertPlanIssues, completedStageIssues, inspectPlan } from './plan-validation.js';

/** Проверяет роли, инструменты и граф зависимостей до принятия предложенного плана. */
export function validatePlan(
  value: unknown,
  snapshot: ConfigSnapshot,
  tools: ToolRegistry,
  enforcePayloadLimit = true,
): ProjectPlan {
  const result = inspectPlan(value, snapshot, tools, undefined, enforcePayloadLimit);
  assertPlanIssues(result.issues);
  return result.plan!;
}

/** Новая версия не переписывает историю завершённого этапа под прежним идентификатором. */
export function replacePlan(project: ProjectRecord, plan: ProjectPlan): void {
  assertPlanIssues(completedStageIssues(project, plan));
  project.plan = { ...plan, version: (project.plan?.version ?? 0) + 1 };
  const next: ProjectRecord['stages'] = {};
  for (const stage of plan.stages) {
    const previous = project.stages[stage.id];
    next[stage.id] =
      previous?.status === 'completed'
        ? previous
        : {
            stageId: stage.id,
            status: 'pending',
            attempt: 0,
            definitionHash: hash(stage),
          };
  }
  project.stages = next;
  project.status = 'ready';
  project.phase = 'baseline';
  delete project.reason;
  delete project.reasonCode;
  delete project.resultSnapshot;
  delete project.intent;
}

/** Первая и итоговая проверки используют принятые команды, без повторного выбора моделью. */
export function allChecks(plan: VersionedPlan) {
  const seen = new Set<string>();
  return plan.stages
    .flatMap((stage) => (stage.verification.kind === 'commands' ? stage.verification.checks : []))
    .filter((check) => {
      const key = hash({ command: check.command, args: check.args });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Планировщик получает формат предложения; исполнительные разрешения ограничивает runtime. */
export function planningMessage(project: ProjectRecord, feedback = ''): string {
  return [
    'Исследуй выбранную папку только чтением и предложи последовательный план разработки кода.',
    'Не запускай команды и не меняй файлы. Это планирование до разрешения человека.',
    'Верни только JSON следующего формата. Не добавляй поля статуса, разрешений или конфигурации.',
    JSON.stringify({
      maxCorrections: project.config.value.projects?.maxCorrections ?? 2,
      fixBaselineFailures: false,
      stages: [
        {
          id: 'stage-1',
          title: 'Краткое название',
          task: 'Что требуется сделать',
          role: project.config.value.defaultRole,
          dependsOn: [],
          expectedResult: 'Проверяемый результат',
          requiredTools: ['fs.read'],
          verification: {
            kind: 'commands',
            checks: [
              { id: 'check-1', title: 'Проверка результата', command: 'node', args: ['--test'] },
            ],
          },
        },
      ],
    }),
    'Если автоматическая проверка неизвестна: verification={"kind":"manual","instructions":"Точные действия человека и ожидаемый результат"}. Не выдумывай существование тестов.',
    'Роли из конфигурации: ' + Object.keys(project.config.value.roles).join(', '),
    'Операционная система: ' + process.platform + '. Папка: ' + project.workspace,
    'Цель: ' + project.goal,
    project.plan
      ? 'Текущий план; сохрани завершённые этапы без изменений: ' + JSON.stringify(project.plan)
      : '',
    feedback ? 'Пожелания человека к плану: ' + feedback : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Допускает единственный JSON-блок, не превращая свободный текст модели в команды. */
export function parsePlan(text: string): unknown {
  const content = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1');
  try {
    return JSON.parse(content);
  } catch {
    throw new ApplicationError(
      'INVALID_PLAN',
      'Модель не вернула корректный JSON плана. Попросите исправить предложение.',
    );
  }
}
