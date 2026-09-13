import type { Profile } from '../configuration/schema.js';
import type { JsonObject } from '../shared/primitives.js';
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
  reasoning?: string;
  reasoningSignature?: string;
  redactedReasoning?: string[];
}
/** Контракт модели независимо от транспорта; вызовы возвращаются целиком и структурированно. */
export interface ModelProvider {
  generate(request: ModelRequest): Promise<ModelOutput>;
}
