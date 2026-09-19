import { z } from 'zod';
import { id, Serial } from '../shared/primitives.js';
import type { SessionStore } from '../sessions/ports.js';
import type { RunRecord } from '../sessions/types.js';

export const runMessageSchema = z
  .object({
    runId: z.string().uuid(),
    message: z
      .string()
      .min(1)
      .max(100000)
      .refine((text) => !!text.trim(), 'Введите сообщение.'),
    requestKey: z.string().min(1).max(200),
  })
  .strict();
export type RunMessageInput = z.infer<typeof runMessageSchema>;
export interface MessageReceipt {
  runId: string;
  sessionId: string;
  messageId: string;
  status: 'queued' | 'delivered';
}

/** Проверка очереди не зависит от текущей роли после handoff. */
export function hasPendingMessages(run: RunRecord): boolean {
  return run.userMessages?.some((item) => !item.deliveredAt) ?? false;
}

/** Принимает сообщения без отмены текущих операций; повторный ключ возвращает прежнюю квитанцию. */
export class RunInbox {
  private readonly serial = new Serial();
  constructor(private readonly store: SessionStore) {}

  /** Сохраняет новое уточнение либо возвращает квитанцию идентичного запроса. */
  send(input: RunMessageInput): Promise<MessageReceipt> {
    const request = runMessageSchema.parse(input);
    return this.serial.run(async () => {
      this.store.assertWritable();
      let run = await this.store.load(request.runId);
      let entry = run.userMessages?.find((item) => item.requestKey === request.requestKey);
      if (entry && entry.content !== request.message)
        throw new Error('Ключ отправки уже использован для другого сообщения.');
      // Квитанция остаётся доступной после завершения задачи: ответ сервиса мог потеряться.
      if (!entry) {
        const messageId = id();
        run = await this.store.mutate(
          run.id,
          'user.message_queued',
          { agentId: run.rootAgentId, messageId, text: request.message },
          (state) => {
            if (state.deletedAt) throw new Error('Скрытая задача доступна только для просмотра.');
            if (!['running', 'awaiting_approval', 'paused'].includes(state.status))
              throw new Error(
                'Задача уже завершена. Сообщение не отправлено; продолжите беседу новым этапом.',
              );
            (state.userMessages ??= []).push({
              id: messageId,
              requestKey: request.requestKey,
              content: request.message,
              receivedAt: new Date().toISOString(),
            });
          },
        );
        entry = run.userMessages!.find((item) => item.id === messageId)!;
      }
      return {
        runId: run.id,
        sessionId: run.sessionId,
        messageId: entry.id,
        status: entry.deliveredAt ? 'delivered' : 'queued',
      };
    });
  }
}

/** Включает очередь только между полными обменами; поток модели и compaction её не затирают. */
export async function deliverMessages(store: SessionStore, run: RunRecord): Promise<RunRecord> {
  if (!hasPendingMessages(run)) return run;
  const messageIds = (run.userMessages ?? [])
    .filter((item) => !item.deliveredAt)
    .map((item) => item.id);
  return store.mutate(
    run.id,
    'user.message_delivered',
    { agentId: run.rootAgentId, messageIds },
    (state) => {
      const root = state.agents[state.rootAgentId]!;
      if (root.pending?.length) throw new Error('Сначала завершите текущие вызовы инструментов.');
      for (const item of state.userMessages ?? []) {
        if (item.deliveredAt || !messageIds.includes(item.id)) continue;
        root.messages.push({ role: 'user', content: item.content });
        item.deliveredAt = new Date().toISOString();
      }
      root.status = 'running';
      delete root.result;
    },
  );
}
