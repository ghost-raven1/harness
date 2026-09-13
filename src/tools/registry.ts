import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { ToolDefinition } from '../providers/types.js';
import type { Config } from '../configuration/schema.js';
const Ajv = AjvModule.default ?? AjvModule;
export interface ToolContext {
  runId: string;
  invocationId?: string;
  previewToken?: string;
  workspace: string;
  config: Config;
  signal: AbortSignal;
}
/** Контракт инструмента: доверенная схема, классификация и исполнение с отменой. */
export interface ToolExecutor {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}
/** Хранит инструменты и заранее компилирует схемы проверки аргументов. */
export class ToolRegistry {
  private readonly entries = new Map<string, { tool: ToolExecutor; validate: ValidateFunction }>();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  /** Регистрирует уникальное имя инструмента и компилирует валидатор его аргументов. */
  register(tool: ToolExecutor): void {
    if (this.entries.has(tool.definition.name))
      throw new Error('Duplicate tool: ' + tool.definition.name);
    this.entries.set(tool.definition.name, {
      tool,
      validate: this.ajv.compile(tool.definition.schema),
    });
  }
  /** Возвращает схемы зарегистрированных инструментов для передачи модели. */
  definitions(): ToolDefinition[] {
    return [...this.entries.values()].map((entry) => entry.tool.definition);
  }
  /** Возвращает исполнитель по точному имени; неизвестный инструмент отклоняется. */
  get(name: string): ToolExecutor {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('Unknown tool: ' + name);
    return entry.tool;
  }
  /** Проверяет аргументы по схеме инструмента и сообщает об ошибках до исполнения. */
  validate(name: string, args: unknown): void {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('Unknown tool: ' + name);
    if (!entry.validate(args))
      throw new Error('Invalid tool arguments: ' + this.ajv.errorsText(entry.validate.errors));
  }
}
