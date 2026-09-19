import { ApplicationError } from '../shared/application-error.js';
import { hash } from '../shared/primitives.js';
import type { ConfigSnapshot } from '../configuration/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import { PolicyService } from '../policy/service.js';
import { projectPlanSchema } from './schema.js';
import type { ProjectPlan, ProjectRecord, ProjectStage } from './types.js';
import type { PlanIssue } from './plan-schema.js';

/** Одна проверка защищает завершённые этапы при сохранении и при предварительной валидации. */
export function completedStageIssues(project: ProjectRecord, plan: ProjectPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const previous of Object.values(project.stages)) {
    if (previous.status !== 'completed') continue;
    const index = plan.stages.findIndex((stage) => stage.id === previous.stageId);
    if (index < 0)
      issues.push({
        path: ['stages'],
        code: 'completed_stage',
        message:
          'Сохраните завершённый этап «' +
          previous.stageId +
          '»; новая работа оформляется новым этапом.',
      });
    else if (hash(plan.stages[index]) !== previous.definitionHash)
      issues.push({
        path: ['stages', index],
        code: 'completed_stage',
        message:
          'Завершённый этап нельзя переписать. Добавьте новый этап с другим идентификатором.',
      });
  }
  return issues;
}

/** Проверяет весь черновик без исполнения, записи состояния и обращения к модели. */
export function inspectPlan(
  value: unknown,
  snapshot: ConfigSnapshot,
  tools: ToolRegistry,
  project?: ProjectRecord,
  enforcePayloadLimit = true,
): { issues: PlanIssue[]; plan?: ProjectPlan } {
  // У сохранённой редакции уже нет транспортного запроса; прежний формат остаётся допустимым.
  if (enforcePayloadLimit && Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 900 * 1024)
    return {
      issues: [
        {
          path: [],
          code: 'payload_too_large',
          message: 'План превышает 900 КиБ. Сократите текст или число проверок перед сохранением.',
        },
      ],
    };
  const parsed = projectPlanSchema.safeParse(value);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map(({ path, code, message }) => ({ path, code, message })),
    };
  const plan = parsed.data;
  const issues: PlanIssue[] = [];
  const add = (path: PlanIssue['path'], code: string, message: string) =>
    issues.push({ path, code, message });
  const config = snapshot.value,
    policy = new PolicyService();
  const stages = new Map<string, ProjectStage>();
  for (const [index, stage] of plan.stages.entries()) {
    if (stages.has(stage.id))
      add(['stages', index, 'id'], 'duplicate_id', 'Идентификаторы этапов должны различаться.');
    stages.set(stage.id, stage);
  }
  const names = new Set(tools.definitions().map((tool) => tool.name));
  const checks = new Set<string>();
  for (const [index, stage] of plan.stages.entries()) {
    const path: PlanIssue['path'] = ['stages', index];
    const knownRole = Object.hasOwn(config.roles, stage.role);
    if (!knownRole)
      add([...path, 'role'], 'unknown_role', 'В конфигурации нет роли: ' + stage.role);
    for (const [i, dependency] of stage.dependsOn.entries()) {
      if (!stages.has(dependency))
        add(
          [...path, 'dependsOn', i],
          'missing_dependency',
          'Не найден этап зависимости: ' + dependency,
        );
      if (stage.dependsOn.indexOf(dependency) !== i)
        add([...path, 'dependsOn', i], 'duplicate_dependency', 'Зависимость указана повторно.');
    }
    for (const [i, tool] of stage.requiredTools.entries())
      if (
        !names.has(tool) ||
        (knownRole &&
          !policy.canAdvertise(
            config,
            { role: stage.role, authorityRoles: [config.defaultRole] },
            tool,
          ))
      )
        add(
          [...path, 'requiredTools', i],
          'unavailable_tool',
          'Этапу недоступен инструмент: ' + tool,
        );
    if (stage.verification.kind !== 'commands') continue;
    const ids = new Set<string>();
    for (const [i, check] of stage.verification.checks.entries()) {
      const checkPath = [...path, 'verification', 'checks', i];
      if (ids.has(check.id))
        add(
          [...checkPath, 'id'],
          'duplicate_id',
          'Идентификаторы проверок этапа должны различаться.',
        );
      ids.add(check.id);
      checks.add(hash({ command: check.command, args: check.args }));
      try {
        tools.validate('process.exec', { command: check.command, args: check.args });
      } catch {
        add(
          [...checkPath, 'command'],
          'unavailable_command',
          'Недоступна команда проверки: ' + check.title,
        );
      }
      if (
        policy.decide(config, { role: config.defaultRole, authorityRoles: [] }, 'process.exec', {
          command: check.command,
          args: check.args,
        }) === 'deny'
      )
        add(
          [...checkPath, 'command'],
          'denied_command',
          'Политика запрещает команду проверки: ' + check.title,
        );
    }
  }
  if (checks.size > 100)
    add(
      ['stages'],
      'too_many_checks',
      'План допускает не более 100 разных команд проверок. Сократите или объедините команды.',
    );
  const ordered: ProjectStage[] = [],
    visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id) || !stages.has(id)) return;
    if (visiting.has(id)) {
      add(
        ['stages', plan.stages.findIndex((stage) => stage.id === id), 'dependsOn'],
        'dependency_cycle',
        'В зависимостях этапов есть цикл.',
      );
      return;
    }
    visiting.add(id);
    for (const dependency of stages.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    ordered.push(stages.get(id)!);
  };
  for (const stage of plan.stages) visit(stage.id);
  const normalized = { ...plan, stages: ordered };
  if (project) issues.push(...completedStageIssues(project, normalized));
  return { issues, ...(issues.length ? {} : { plan: normalized }) };
}

/** Преобразует тот же набор ошибок в исключение существующего контракта сохранения. */
export function assertPlanIssues(issues: PlanIssue[]): void {
  if (issues.length)
    throw new ApplicationError(
      'INVALID_PLAN',
      issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '),
    );
}
