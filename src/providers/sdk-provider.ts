import { limitedFetch } from './limited-fetch.js';
import { APICallError } from '@ai-sdk/provider';
import { Semaphore, abort, deadline } from '../shared/primitives.js';
import type { ModelProvider, ModelRequest, ModelOutput, ToolCall } from './types.js';
import { ProviderError } from './errors.js';
import { providerLimit, limitError } from './rate-limits.js';
import { retryModelRequest } from './retry.js';
import { createModel } from './adapters.js';
import { mapPrompt } from './prompt.js';
import { ModelAttemptObservation, observedTokens, observeModelQueue } from './observation.js';

/** Использует поток провайдера AI SDK, сохраняя исполнение и восстановление в нашем runtime. */
export class SdkModelProvider implements ModelProvider {
  readonly observesRequests = true;
  private readonly limiter: Semaphore;
  constructor(
    concurrency: number,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.limiter = new Semaphore(concurrency);
  }
  /** Ожидает свободное место и выполняет запрос SDK с ограниченным числом повторов. */
  generate(request: ModelRequest): Promise<ModelOutput> {
    return observeModelQueue(request, this.limiter, () =>
      retryModelRequest(request, (observation) => this.once(request, observation)),
    );
  }
  /** Собирает текст, вызовы и расход из полного потока SDK; обрыв возвращает как ошибку. */
  private async once(
    request: ModelRequest,
    observation: ModelAttemptObservation,
  ): Promise<ModelOutput> {
    const timeout = deadline(request.signal, request.profile.timeoutMs);
    try {
      const mapped = mapPrompt(request);
      const response = await createModel(request.profile, limitedFetch(this.fetcher)).doStream({
        inputFormat: 'messages',
        prompt: mapped.prompt,
        maxTokens: request.profile.outputTokens,
        abortSignal: timeout.signal,
        mode: {
          type: 'regular',
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function' as const,
                  name: mapped.alias(tool.name),
                  description: tool.name + ': ' + tool.description,
                  parameters: tool.schema,
                })),
              }
            : {}),
        },
      });
      const output: ModelOutput = {
        text: '',
        calls: [],
        finish: 'stop',
        usage: { input: 0, output: 0 },
      };
      const partial = new Map<string, ToolCall>(),
        complete = new Map<string, ToolCall>();
      let finished = false,
        bytes = 0;
      let usageSource: ModelOutput['usageSource'];
      const reader = response.stream.getReader();
      try {
        while (true) {
          abort(timeout.signal);
          const item = await reader.read();
          if (item.done) break;
          bytes += Buffer.byteLength(JSON.stringify(item.value));
          if (bytes > 8 * 1024 * 1024) throw new ProviderError('Model response exceeds byte limit');
          const part = item.value;
          if (part.type === 'error') {
            if (APICallError.isInstance(part.error)) throw part.error;
            const limit = providerLimit(part.error);
            throw limit
              ? limitError(limit)
              : new ProviderError('Model stream returned invalid data');
          }
          if (part.type === 'text-delta') {
            if (part.textDelta) observation.firstOutput();
            output.text += part.textDelta;
            request.onProgress?.({ type: 'text', text: part.textDelta });
          }
          if (part.type === 'reasoning') {
            if (part.textDelta) observation.firstOutput();
            output.reasoning = (output.reasoning ?? '') + part.textDelta;
            request.onProgress?.({ type: 'reasoning', text: part.textDelta });
          }
          if (part.type === 'reasoning-signature') output.reasoningSignature = part.signature;
          if (part.type === 'redacted-reasoning') (output.redactedReasoning ??= []).push(part.data);
          if (part.type === 'tool-call-delta') {
            observation.firstOutput();
            const call = partial.get(part.toolCallId) ?? {
              id: part.toolCallId,
              name: mapped.names.get(part.toolName) ?? part.toolName,
              arguments: '',
            };
            call.arguments += part.argsTextDelta;
            partial.set(call.id, call);
          }
          if (part.type === 'tool-call') {
            observation.firstOutput();
            complete.set(part.toolCallId, {
              id: part.toolCallId,
              name: mapped.names.get(part.toolName) ?? part.toolName,
              // Anthropic без дельт оставляет исходный input: {}; SDK передаёт его пустой строкой.
              arguments:
                request.profile.provider === 'anthropic' && part.args === '' ? '{}' : part.args,
            });
          }
          if (part.type === 'finish') {
            const input = observedTokens(part.usage.promptTokens);
            const produced = observedTokens(part.usage.completionTokens);
            observation.usage({
              input,
              output: produced,
              source: input !== null || produced !== null ? 'provider' : 'unavailable',
            });
            if (!['stop', 'tool-calls', 'length'].includes(part.finishReason))
              throw new ProviderError(
                'Incomplete or unsupported model finish: ' + part.finishReason,
              );
            finished = true;
            output.finish =
              part.finishReason === 'tool-calls'
                ? 'tools'
                : (part.finishReason as 'stop' | 'length');
            output.usage = { input: part.usage.promptTokens, output: part.usage.completionTokens };
            usageSource = input !== null && produced !== null ? 'provider' : 'estimate';
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (!finished) throw new ProviderError('Incomplete model stream', true);
      output.calls = [...new Set([...partial.keys(), ...complete.keys()])].map(
        (key) => complete.get(key) ?? partial.get(key)!,
      );
      if (output.calls.some((call) => !call.id || !call.name))
        throw new ProviderError('Incomplete tool call');
      if (output.finish === 'tools' && !output.calls.length)
        throw new ProviderError('Tool calls missing from response');
      if (output.finish === 'stop' && !output.calls.length && !output.text.trim())
        throw new ProviderError('Модель вернула пустой ответ без вызовов инструментов.');
      if (observedTokens(output.usage.input) === null)
        output.usage.input = Buffer.byteLength(JSON.stringify(mapped.prompt));
      if (observedTokens(output.usage.output) === null)
        output.usage.output = Buffer.byteLength(JSON.stringify(output));
      output.usageSource = usageSource;
      return output;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (APICallError.isInstance(error)) {
        let body: unknown;
        try {
          body = JSON.parse(error.responseBody ?? 'null');
        } catch {
          /* Текст ошибки не классифицируется. */
        }
        const limit = providerLimit(body, error.statusCode, error.responseHeaders);
        if (limit) throw limitError(limit);
        throw new ProviderError(
          'Model API HTTP ' + error.statusCode,
          error.isRetryable,
          error.statusCode === 400 &&
            /context.*(length|limit|window)|maximum.*tokens/i.test(error.responseBody ?? ''),
        );
      }
      throw new ProviderError(
        timeout.signal.aborted ? 'Model request cancelled or timed out' : 'Provider adapter failed',
      );
    } finally {
      timeout.close();
    }
  }
}
