import type { Profile } from '../configuration/schema.js';
import type { JsonObject } from '../shared/primitives.js';
import type { ExecutionObservation, UsageSource } from '../insights/ports.js';
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
  reasoningSignature?: string;
  redactedReasoning?: string[];
}
export interface ToolDefinition {
  name: string;
  description: string;
  schema: JsonObject;
  effect: 'read' | 'write';
}
export interface ModelRequest {
  profile: Profile;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  /** Наблюдатель уже привязан к запуску, агенту и конкретному запросу. */
  observation?: ExecutionObservation;
  onProgress?(event: ModelProgress): void;
}
/** Только опубликованный текст провайдера; подписи и скрытые блоки сюда не передаются. */
export type ModelProgress =
  | { type: 'text' | 'reasoning'; text: string }
  | { type: 'retry'; attempt: number };
export interface ModelOutput {
  text: string;
  calls: ToolCall[];
  finish: 'stop' | 'tools' | 'length';
  usage: { input: number; output: number };
  /** Происхождение расхода; числовой контракт usage сохраняется для старых клиентов. */
  usageSource?: UsageSource;
  reasoning?: string;
  reasoningSignature?: string;
  redactedReasoning?: string[];
}
/** Контракт модели независимо от транспорта; вызовы возвращаются целиком и структурированно. */
export interface ModelProvider {
  /** Адаптер сам измеряет попытки и очереди; обёртка передаёт ему observation без повторного учёта. */
  readonly observesRequests?: boolean;
  generate(request: ModelRequest): Promise<ModelOutput>;
}
