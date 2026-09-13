import { join } from 'node:path';
import { z } from 'zod';
import { id, Serial } from '../shared/primitives.js';
import type { ModelOutput, ModelProgress } from '../providers/types.js';
import { appendJournalBatch, readJournal } from './journal.js';

const schema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  role: z.string(),
  type: z.enum(['started', 'text', 'reasoning', 'retry', 'completed', 'failed', 'truncated']),
  text: z.string().max(4096).optional(),
});
export type OutputEvent = z.infer<typeof schema>;
type NewEvent = Omit<OutputEvent, 'seq'>;

/** Поток интерфейса хранится отдельно: фрагменты текста не копируют снимок всего запуска. */
export class RunOutputStore {
  private readonly records = new Map<string, OutputEvent[]>();
  private readonly serial = new Serial();
  constructor(private readonly directory: string) {}
  /** Убирает поток из памяти после остановки всех писателей удаляемой беседы. */
  forget(runIds: string[]): Promise<void> {
    return this.serial.run(async () => {
      for (const runId of runIds) this.records.delete(runId);
    });
  }
  private path(runId: string): string {
    return join(this.directory, 'output', runId + '.jsonl');
  }
  private async load(runId: string): Promise<OutputEvent[]> {
    if (!this.records.has(runId)) {
      const events = (await readJournal<unknown>(this.path(runId))).map((row, index) => {
        const event = schema.parse(row);
        if (event.seq !== index + 1) throw new Error('Повреждён журнал вывода задачи.');
        return event;
      });
      this.records.set(runId, events);
    }
    return this.records.get(runId)!;
  }
  async page(
    runId: string,
    cursor: number,
  ): Promise<{ events: OutputEvent[]; cursor: number; hasMore: boolean }> {
    return this.serial.run(async () => {
      const records = await this.load(runId);
      const events = records.slice(cursor, cursor + 32);
      const next = events.at(-1)?.seq ?? cursor;
      return { events: structuredClone(events), cursor: next, hasMore: records.length > next };
    });
  }
  append(runId: string, events: NewEvent[]): Promise<void> {
    return this.serial.run(async () => {
      const records = await this.load(runId);
      const rows = events.map((event, index) => ({ ...event, seq: records.length + index + 1 }));
      await appendJournalBatch(this.path(runId), rows);
      records.push(...rows);
    });
  }
  async begin(runId: string, agentId: string, role: string): Promise<ModelOutputWriter> {
    const writer = new ModelOutputWriter(this, runId, agentId, role);
    await writer.start();
    return writer;
  }
}

/** Объединяет токены в пачки; остановка модели дожидается записи последнего фрагмента. */
export class ModelOutputWriter {
  readonly requestId = id();
  private pending: NewEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private failure?: unknown;
  private readonly serial = new Serial();
  private readonly length = { text: 0, reasoning: 0 };
  private readonly seen = { text: false, reasoning: false };
  private clipped = false;
  private closed = false;
  constructor(
    private readonly store: RunOutputStore,
    private readonly runId: string,
    private readonly agentId: string,
    private readonly role: string,
  ) {}
  private event(type: OutputEvent['type'], text?: string): NewEvent {
    return {
      at: new Date().toISOString(),
      requestId: this.requestId,
      agentId: this.agentId,
      role: this.role,
      type,
      ...(text === undefined ? {} : { text }),
    };
  }
  async start(): Promise<void> {
    await this.store.append(this.runId, [this.event('started')]);
  }
  progress = (event: ModelProgress): void => {
    if (this.closed) return;
    if (event.type === 'retry') {
      this.pending.push(this.event('retry', 'Повтор подключения: попытка ' + event.attempt));
      this.seen.text = this.seen.reasoning = false;
    } else {
      if (!event.text) return;
      this.seen[event.type] = true;
      const text = event.text.slice(0, Math.max(0, 65536 - this.length[event.type]));
      this.length[event.type] += text.length;
      for (let offset = 0; offset < text.length; offset += 4096) {
        const last = this.pending.at(-1),
          chunk = text.slice(offset, offset + 4096);
        if (last?.type === event.type && (last.text?.length ?? 0) + chunk.length <= 4096)
          last.text = (last.text ?? '') + chunk;
        else this.pending.push(this.event(event.type, chunk));
      }
      if (text.length < event.text.length && !this.clipped) {
        this.clipped = true;
        this.pending.push(
          this.event(
            'truncated',
            'Достигнут лимит предпросмотра. Итоговый ответ сохраняется отдельно.',
          ),
        );
      }
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => {
        this.failure = error;
      });
    }, 150);
  };
  private flush(): Promise<void> {
    const batch = this.pending.splice(0);
    return this.serial.run(async () => {
      if (batch.length) await this.store.append(this.runId, batch);
    });
  }
  async finish(output?: ModelOutput): Promise<void> {
    if (output) {
      if (!this.seen.text && output.text) this.progress({ type: 'text', text: output.text });
      if (!this.seen.reasoning && output.reasoning)
        this.progress({ type: 'reasoning', text: output.reasoning });
    }
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.push(this.event(output ? 'completed' : 'failed'));
    await this.flush();
    if (this.failure) throw this.failure;
  }
}
