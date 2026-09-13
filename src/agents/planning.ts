import { z } from 'zod';
import type { RunRecord, AgentState } from '../sessions/types.js';
import type { ModelOutput, ToolCall, ToolDefinition } from '../providers/types.js';
import type { PolicyService } from '../policy/service.js';
import { id } from '../shared/primitives.js';

const taskSchema = z
  .object({
    role: z.string().min(1),
    task: z.string().trim().min(1).max(20000),
    context: z.string().max(20000).default(''),
  })
  .strict();
const planSchema = z
  .object({
    mode: z.enum(['direct', 'parallel', 'handoff']),
    reason: z.string().trim().min(1).max(2000),
    tasks: z.array(taskSchema).max(31),
  })
  .strict();
export type CoordinationPlan = z.infer<typeof planSchema>;
export interface CoordinationState {
  attempts: number;
  plan?: CoordinationPlan;
}

/** Выбор маршрута не исполняет инструменты: права проверяются у каждого полученного вызова. */
export function planningDefinition(run: RunRecord): ToolDefinition {
  return {
    name: 'agents.plan',
    effect: 'read',
    description:
      'Choose direct work, independent parallel subtasks, or handoff using configured roles. This records a plan; ordinary tool permissions still apply.',
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['direct', 'parallel', 'handoff'] },
        reason: {
          type: 'string',
          description: 'Brief explanation for the user, in their language.',
        },
        tasks: {
          type: 'array',
          maxItems: 31,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string', enum: Object.keys(run.config.value.roles) },
              task: { type: 'string' },
              context: { type: 'string' },
            },
            required: ['role', 'task', 'context'],
          },
        },
      },
      required: ['mode', 'reason', 'tasks'],
      additionalProperties: false,
    },
  };
}

/** Планируется только новый корневой ход; старые снимки продолжают прежний цикл. */
export function needsPlanning(run: RunRecord, agent: AgentState): boolean {
  return agent.id === run.rootAgentId && !!run.coordination && !run.coordination.plan;
}

export function planningInstruction(run: RunRecord): string {
  return [
    'HARNESS ROUTING: before execution, call agents.plan exactly once. Do not call other tools yet.',
    'Use only roles from CONFIGURED ROLES and their authored specializations. Never invent role names.',
    'For a complex task with independent parts, choose parallel and assign bounded tasks to suitable roles.',
    'Put only independent work in the same batch; avoid overlapping edits. Pass relevant facts and expected results in context.',
    'Dependent review or follow-up work must be delegated after its inputs are ready, using agents.delegate/await.',
    'For one specialized task choose handoff with exactly one task. For simple work or clarification choose direct with no tasks.',
    'A plan is not a grant of permissions. Restrictions and approvals apply to all delegated work.',
    `Available child slots: ${Math.max(0, run.config.value.limits.agents - 1)}; delegation depth: ${run.config.value.limits.depth}; handoffs: ${run.config.value.limits.handoffs - run.handoffs}.`,
  ].join('\n');
}

/** Проверяет структуру, роли, права и размер команды до записи исполняемых вызовов. */
export function validatePlan(
  output: ModelOutput,
  run: RunRecord,
  agent: AgentState,
  policy: PolicyService,
): CoordinationPlan {
  if (output.calls.length !== 1 || output.calls[0]!.name !== 'agents.plan')
    throw new Error('Ожидается один структурированный вызов agents.plan.');
  const plan = planSchema.parse(JSON.parse(output.calls[0]!.arguments));
  if (plan.mode === 'direct' && plan.tasks.length)
    throw new Error('Прямая работа не должна содержать подзадачи.');
  if (
    plan.mode === 'handoff' &&
    (plan.tasks.length !== 1 || run.handoffs >= run.config.value.limits.handoffs)
  )
    throw new Error('Передаче роли нужна ровно одна задача и доступный предел handoff.');
  if (
    plan.mode === 'parallel' &&
    (!plan.tasks.length ||
      plan.tasks.length >= run.config.value.limits.agents ||
      agent.depth >= run.config.value.limits.depth)
  )
    throw new Error('Размер команды или глубина делегирования превышает конфигурацию.');
  for (const task of plan.tasks) {
    if (!Object.hasOwn(run.config.value.roles, task.role))
      throw new Error('Роль отсутствует в конфигурации: ' + task.role);
    const tool = plan.mode === 'handoff' ? 'agents.handoff' : 'agents.delegate';
    const args = plan.mode === 'handoff' ? { role: task.role, reason: plan.reason } : task;
    if (policy.decide(run.config.value, agent, tool, args) === 'deny')
      throw new Error('Политика запрещает выбранную передачу: ' + task.role);
  }
  return plan;
}

/** Преобразует проверенный план в обычные вызовы с сохранёнными ID для восстановления. */
export function plannedCalls(plan: CoordinationPlan): ToolCall[] {
  return plan.tasks.map((task) => ({
    id: id(),
    name: plan.mode === 'handoff' ? 'agents.handoff' : 'agents.delegate',
    arguments: JSON.stringify(
      plan.mode === 'handoff' ? { role: task.role, reason: plan.reason } : task,
    ),
  }));
}
