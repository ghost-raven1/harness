import type { ModelOutput, ModelProvider, ModelRequest, ToolCall } from '../providers/types.js';
import type { BenchmarkMode, BenchmarkScenario } from './types.js';
import { observedProvider } from '../runtime/observations.js';

/** Ответы стенда не обращаются к сети и продолжают шаги по сохранённой истории. */
export class BenchmarkProvider implements ModelProvider {
  constructor(private readonly scenario: BenchmarkScenario) {}

  /** Восстанавливает очередной учебный шаг по связанным вызовам в истории. */
  async generate(request: ModelRequest): Promise<ModelOutput> {
    request.signal?.throwIfAborted();
    if (request.tools.length === 1 && request.tools[0]?.name === 'agents.plan')
      return fixedPlanOutput(this.scenario);
    const calls = request.messages.flatMap((entry) => entry.toolCalls ?? []);
    const task = request.messages.at(-1)?.content ?? '';
    const partIndex = /\[BENCH:[a-z-]+:part(\d+)\]/.exec(task)?.[1];
    const delegated = calls.some((call) => call.name === 'agents.delegate');
    const collected = request.messages.some((entry) =>
      entry.content.startsWith('[HARNESS: incorporate completed child results]'),
    );
    if (delegated && !collected) return answer('Ожидаю результаты независимых веток.');
    const parts =
      partIndex !== undefined
        ? [this.scenario.parts[Number(partIndex)]!]
        : delegated
          ? []
          : this.scenario.parts;
    const steps = parts.flatMap((part) => [
      ...part.reads.map((path) => ({ name: 'fs.read', args: { path } })),
      ...Object.entries(part.writes).map(([path, content]) => ({
        name: 'fs.write',
        args: { path, content },
      })),
    ]);
    if (partIndex === undefined)
      steps.push(
        ...Object.entries(this.scenario.finalWrites).map(([path, content]) => ({
          name: 'fs.write',
          args: { path, content },
        })),
      );
    const index = steps.findIndex(
      (_, index) => !calls.some((call) => call.id === 'bench-step-' + index),
    );
    if (index >= 0) {
      const step = steps[index]!;
      return answer('Выполняю подготовленный учебный шаг.', [
        { id: 'bench-step-' + index, name: step.name, arguments: JSON.stringify(step.args) },
      ]);
    }
    return answer(
      partIndex !== undefined && this.scenario.id === 'research'
        ? 'Источники: runtime=Node.js; storage=JSONL; acceptance=human.'
        : 'Подготовленные действия закончены; результат оценит доверенная проверка.',
    );
  }
}

/** Только начальный fixed-план задан стендом; все последующие запросы обслуживает исходная модель. */
export class BenchmarkRoutingProvider implements ModelProvider {
  readonly observesRequests = true;
  private readonly provider: ModelProvider;
  constructor(
    provider: ModelProvider,
    private readonly scenario: BenchmarkScenario,
    private readonly mode: BenchmarkMode,
  ) {
    this.provider = observedProvider(provider);
  }
  /** Подставляет только доверенный начальный план и сохраняет наблюдение остальных запросов. */
  generate(request: ModelRequest): Promise<ModelOutput> {
    if (
      this.mode === 'fixed' &&
      request.tools.length === 1 &&
      request.tools[0]?.name === 'agents.plan'
    ) {
      request.signal?.throwIfAborted();
      return Promise.resolve(fixedPlanOutput(this.scenario));
    }
    return this.provider.generate(request);
  }
}

/** Возвращает обычный структурированный вызов: его роли и права повторно проверит runtime. */
function fixedPlanOutput(scenario: BenchmarkScenario): ModelOutput {
  return answer(scenario.fixedPlan.reason, [
    { id: 'benchmark-plan', name: 'agents.plan', arguments: JSON.stringify(scenario.fixedPlan) },
  ]);
}

/** У подготовленного провайдера нет оплаченных токенов; эффективность оценивают только реальные запуски. */
function answer(text: string, calls: ToolCall[] = []): ModelOutput {
  return { text, calls, finish: calls.length ? 'tools' : 'stop', usage: { input: 0, output: 0 } };
}
