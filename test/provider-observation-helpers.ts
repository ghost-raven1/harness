import type {
  ActivityOutcome,
  ActivityPhase,
  ExecutionObservation,
  ObservedUsage,
  ObservationDetails,
} from '../src/insights/ports.js';
import type { ModelRequest } from '../src/providers/types.js';
import { fixtureConfig } from './helpers.js';

/** Фиксирует порядок границ без предположений о скорости машины и планировщика. */
export function observationFixture() {
  let sequence = 0;
  const spans: Array<{
    phase: ActivityPhase;
    details?: ObservationDetails;
    started: number;
    ended?: number;
    outcome?: ActivityOutcome;
    ends: number;
  }> = [];
  const usages: Array<{ usage: ObservedUsage; details?: ObservationDetails }> = [];
  const observation: ExecutionObservation = {
    begin(phase, details) {
      const span: (typeof spans)[number] = { phase, details, started: ++sequence, ends: 0 };
      spans.push(span);
      return {
        end(outcome = 'completed') {
          span.ended = ++sequence;
          span.outcome = outcome;
          span.ends++;
        },
      };
    },
    usage(usage, details) {
      usages.push({ usage: { ...usage }, details });
    },
  };
  return { observation, spans, usages };
}

/** Создаёт запрос с отключёнными повторами, чтобы тест включал их явно. */
export function observedRequest(): ModelRequest {
  return {
    profile: { ...fixtureConfig('/tmp').profiles.test!, retries: 0 },
    messages: [{ role: 'user', content: 'Проверь файл' }],
    tools: [{ name: 'fs.read', description: 'Чтение', effect: 'read', schema: { type: 'object' } }],
  };
}

/** Возвращает полный SSE-ответ совместимого API с необязательной статистикой. */
export function observedResponse(
  delta: unknown = { content: 'Готово' },
  usage?: { prompt_tokens: number; completion_tokens: number },
  finish = 'stop',
): Response {
  const parts = [
    {
      id: 'r1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    },
    '[DONE]',
  ];
  return new Response(
    parts
      .map((part) => 'data: ' + (typeof part === 'string' ? part : JSON.stringify(part)) + '\n\n')
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
