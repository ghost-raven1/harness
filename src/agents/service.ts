import { z } from 'zod';
import { id } from '../shared/primitives.js';
import type { RunRecord, AgentState } from '../sessions/types.js';
import type { ToolDefinition } from '../providers/types.js';
import type { Config } from '../configuration/schema.js';

export const delegateSchema = z
  .object({ role: z.string(), task: z.string().min(1), context: z.string().default('') })
  .strict();
export const awaitSchema = z.object({ agentId: z.string() }).strict();
export const handoffSchema = z.object({ role: z.string(), reason: z.string().min(1) }).strict();
/** Описывает аргументы управляющего инструмента без произвольных дополнительных полей. */
const shape = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const controlDefinitions: ToolDefinition[] = [
  {
    name: 'agents.delegate',
    effect: 'write',
    description:
      'Start an independent child agent with a selected role, task and context. Returns its ID.',
    schema: shape(
      { role: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' } },
      ['role', 'task'],
    ),
  },
  {
    name: 'agents.await',
    effect: 'read',
    description:
      'Wait for the result of your own child agent without holding tool execution locks.',
    schema: shape({ agentId: { type: 'string' } }, ['agentId']),
  },
  {
    name: 'agents.handoff',
    effect: 'write',
    description:
      'Transfer this branch to another role. Must be the only call and all children must be finished.',
    schema: shape({ role: { type: 'string' }, reason: { type: 'string' } }, ['role', 'reason']),
  },
];
/** Схемы публикуют роли из снимка задачи, включая пользовательские специализации. */
export function configuredControlDefinitions(config: Config): ToolDefinition[] {
  return controlDefinitions.map((definition) => {
    const tool = structuredClone(definition);
    if (tool.name !== 'agents.await') {
      const properties = tool.schema.properties as Record<string, unknown>;
      properties.role = { type: 'string', enum: Object.keys(config.roles) };
    }
    return tool;
  });
}
/** Создаёт отдельную историю роли и наследует весь потолок прав родительской ветки. */
export function newAgent(
  role: string,
  task: string,
  parent?: AgentState,
  context = '',
): AgentState {
  return {
    id: id(),
    ...(parent ? { parentId: parent.id } : {}),
    role,
    authorityRoles: [
      ...new Set([...(parent?.authorityRoles ?? []), ...(parent ? [parent.role] : []), role]),
    ],
    depth: parent ? parent.depth + 1 : 0,
    task,
    status: 'running',
    messages: [
      { role: 'user', content: task + (context ? '\n[Delegated context]\n' + context : '') },
    ],
    summary: '',
    completedCalls: [],
    children: [],
    collectedChildren: [],
  };
}
/** Проверяет существование роли, глубину и свободное место в команде перед её созданием. */
export function checkDelegation(run: RunRecord, parent: AgentState, role: string): void {
  if (!Object.hasOwn(run.config.value.roles, role)) throw new Error('Unknown role: ' + role);
  if (parent.depth >= run.config.value.limits.depth) throw new Error('Delegation depth exhausted');
  if (
    Object.values(run.agents).filter((agent) => ['running', 'waiting'].includes(agent.status))
      .length >= run.config.value.limits.agents
  ) {
    throw new Error('Agent concurrency budget exhausted');
  }
}
