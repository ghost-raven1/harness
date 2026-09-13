import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from '../sessions/files.js';
import type { FileSessionStore } from '../sessions/store.js';
import type { ModelProvider, ModelRequest } from '../providers/types.js';
import { abort, clone, Serial } from '../shared/primitives.js';

const count = z.number().int().nonnegative();
const daySchema = z.object({
  tasks: count,
  learning: count,
  reportedTasks: count,
  reportedLearning: count,
  extra: count,
});
const schema = z.object({
  schemaVersion: z.literal(1),
  days: z.record(daySchema),
  runs: z.record(z.object({ reserved: count, extra: count })),
});
type Ledger = z.infer<typeof schema>;

/** Сохраняет оценку расхода до API и подтверждённый расход после ответа. */
export class UsageLedger {
  private state: Ledger = { schemaVersion: 1, days: {}, runs: {} };
  private loaded = false;
  private readonly serial = new Serial();
  constructor(
    private readonly store: FileSessionStore,
    private readonly date = () => new Date().toISOString().slice(0, 10),
  ) {}
  /** Загружает учёт один раз; повреждённый файл блокирует новые запросы к API. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = schema.parse(
        JSON.parse(await readFile(join(this.store.directory, 'usage.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Журнал расхода повреждён. Запросы к API остановлены до восстановления usage.json.',
        );
    }
    this.loaded = true;
  }
  /** Обновляет учёт в памяти только после атомарной записи на диск. */
  private async save(next: Ledger): Promise<void> {
    await atomicJson(join(this.store.directory, 'usage.json'), next);
    this.state = next;
  }
  /** Возвращает запись суток UTC, создавая начальные нулевые счётчики. */
  private day(state: Ledger, date: string) {
    return (state.days[date] ??= {
      tasks: 0,
      learning: 0,
      reportedTasks: 0,
      reportedLearning: 0,
      extra: 0,
    });
  }
  /** Возвращает расход выбранной задачи и суток без токеновых ограничений. */
  async status(runId?: string) {
    return this.serial.run(async () => {
      await this.load();
      const date = this.date(),
        daily = this.day(clone(this.state), date);
      if (runId) this.store.get(runId);
      const spent = runId ? this.state.runs[runId] : undefined;
      return {
        date,
        daily,
        dailyLimit: null,
        runReserved: spent?.reserved ?? 0,
        runLimit: null,
        warning: false,
      };
    });
  }
  /** Оборачивает модель предварительным учётом нагрузки и сохранением фактического расхода. */
  provider(source: ModelProvider, runId?: string): ModelProvider {
    return {
      generate: async (request) => {
        abort(request.signal);
        const date = await this.reserve(request, runId);
        abort(request.signal);
        const output = await source.generate(request);
        await this.serial.run(async () => {
          const next = clone(this.state),
            day = this.day(next, date);
          const amount = output.usage.input + output.usage.output;
          if (Number.isSafeInteger(amount) && amount >= 0)
            day[runId ? 'reportedTasks' : 'reportedLearning'] += amount;
          await this.save(next);
        });
        return output;
      },
    };
  }
  /** Записывает оценку запроса с запасом на ответ и повторы до обращения к провайдеру. */
  private reserve(request: ModelRequest, runId?: string): Promise<string> {
    return this.serial.run(async () => {
      await this.load();
      abort(request.signal);
      // Один байт на токен с запасом протокола; все разрешённые повторы учитываются заранее.
      const amount =
        (Buffer.byteLength(
          JSON.stringify({
            messages: request.messages,
            tools: request.tools,
            options: request.profile.options,
          }),
        ) +
          request.profile.outputTokens +
          2048) *
        (request.profile.retries + 1);
      const next = clone(this.state),
        date = this.date(),
        day = this.day(next, date);
      if (runId) {
        this.store.get(runId);
        const spent = (next.runs[runId] ??= { reserved: 0, extra: 0 });
        spent.reserved += amount;
        day.tasks += amount;
      } else day.learning += amount;
      await this.save(next);
      return date;
    });
  }
}
