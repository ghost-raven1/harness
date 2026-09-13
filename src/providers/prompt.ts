import type { LanguageModelV1Prompt } from '@ai-sdk/provider';
import type { ModelRequest } from './types.js';
import { hash } from '../shared/primitives.js';

/** Стабильные псевдонимы поддерживают провайдеров, запрещающих точки в именах функций. */
export function mapPrompt(request: ModelRequest): {
  prompt: LanguageModelV1Prompt;
  names: Map<string, string>;
  alias(name: string): string;
} {
  const alias = (name: string): string => 't_' + hash(name).slice(0, 32);
  const names = new Map(request.tools.map((tool) => [alias(tool.name), tool.name]));
  const callNames = new Map<string, string>();
  for (const message of request.messages)
    for (const call of message.toolCalls ?? []) {
      names.set(alias(call.name), call.name);
      callNames.set(call.id, alias(call.name));
    }
  const prompt: LanguageModelV1Prompt = request.messages.map((message) => {
    if (message.role === 'system') return { role: 'system', content: message.content };
    if (message.role === 'user')
      return { role: 'user', content: [{ type: 'text', text: message.content }] };
    if (message.role === 'tool')
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId!,
            toolName: callNames.get(message.toolCallId!) ?? 'unknown',
            result: message.content,
          },
        ],
      };
    return {
      role: 'assistant',
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.reasoning
          ? [
              {
                type: 'reasoning' as const,
                text: message.reasoning,
                signature: message.reasoningSignature,
              },
            ]
          : []),
        ...(message.redactedReasoning ?? []).map((data) => ({
          type: 'redacted-reasoning' as const,
          data,
        })),
        ...(message.toolCalls ?? []).map((call) => {
          let args: unknown;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            args = call.arguments;
          }
          return {
            type: 'tool-call' as const,
            toolCallId: call.id,
            toolName: alias(call.name),
            args,
          };
        }),
      ],
    };
  });
  return { prompt, names, alias };
}
