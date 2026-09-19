import { ApplicationError } from '../shared/application-error.js';
import { hash } from '../shared/primitives.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import { PolicyService } from '../policy/service.js';
import { projectPlanSchema } from './schema.js';
import type { ProjectPlan, ProjectRecord, ProjectStage, VersionedPlan } from './types.js';

/** Проверяет роли, инструменты и граф зависимостей до принятия предложенного плана. */
export function validatePlan(
  value: unknown,
  snapshot: ConfigSnapshot,
  tools: ToolRegistry,
): ProjectPlan {
  const parsed = projectPlanSchema.safeParse(value);
  const fail = (message: string): never => {
    throw new ApplicationError('INVALID_PLAN', message);
  };
  if (!parsed.success)
    return fail(
      'План не соответствует формату этапов и проверок: ' +
        parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
    );
  const plan = parsed.data,
    config = snapshot.value,
    policy = new PolicyService();
  const stages = new Map(plan.stages.map((stage) => [stage.id, stage]));
  if (stages.size !== plan.stages.length) fail('Идентификаторы этапов должны различаться.');
  const names = new Set(tools.definitions().map((tool) => tool.name));
  for (const stage of plan.stages) {
    if (!Object.hasOwn(config.roles, stage.role)) fail('В конфигурации нет роли: ' + stage.role);
    for (const dependency of stage.dependsOn)
      if (!stages.has(dependency)) fail('Не найден этап зависимости: ' + dependency);
    for (const tool of stage.requiredTools)
      if (
        !names.has(tool) ||
        !policy.canAdvertise(
          config,
          { role: stage.role, authorityRoles: [config.defaultRole] },
          tool,
        )
      )
        fail('Этапу недоступен инструмент: ' + tool);
    if (stage.verification.kind === 'commands') {
      if (
        new Set(stage.verification.checks.map((check) => check.id)).size !==
        stage.verification.checks.length
      )
        fail('Идентификаторы проверок этапа должны различаться.');
      for (const check of stage.verification.checks) {
        try {
          tools.validate('process.exec', { command: check.command, args: check.args });
        } catch {
          fail('Недоступна команда проверки: ' + check.title);
        }
        if (
          policy.decide(config, { role: config.defaultRole, authorityRoles: [] }, 'process.exec', {
            command: check.command,
            args: check.args,
          }) === 'deny'
        )
          fail('Политика запрещает команду проверки: ' + check.title);
      }
    }
  }
  if (allChecks({ ...plan, version: 1 }).length > 100)
    fail('План допускает не более 100 разных команд проверок. Сократите или объедините команды.');
  const ordered: ProjectStage[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) fail('В зависимостях этапов есть цикл.');
    visiting.add(id);
    for (const dependency of stages.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(stages.get(id)!);
  };
  for (const stage of plan.stages) visit(stage.id);
  return { ...plan, stages: ordered };
}

/** Новая версия не переписывает историю завершённого этапа под прежним идентификатором. */
export function replacePlan(project: ProjectRecord, plan: ProjectPlan): void {
  for (const stage of plan.stages) {
    const previous = project.stages[stage.id];
    if (previous?.status === 'completed' && previous.definitionHash !== hash(stage))
      throw new ApplicationError(
        'INVALID_PLAN',
        'Завершённый этап нельзя переписать. Добавьте новый этап с другим идентификатором.',
      );
  }
  for (const previous of Object.values(project.stages))
    if (
      previous.status === 'completed' &&
      !plan.stages.some((stage) => stage.id === previous.stageId)
    )
      throw new ApplicationError(
        'INVALID_PLAN',
        'Сохраните завершённые этапы в плане; новая работа оформляется новым этапом.',
      );
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
