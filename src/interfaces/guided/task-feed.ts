import type { TaskView, StatusView } from '../types.js';
import type { OutputEvent } from '../../sessions/output.js';
import { terminalText } from './screen.js';

export type FeedTab = 'all' | 'log' | 'reasoning' | 'text';
export interface FeedEntry {
  id: string;
  at: string;
  kind: Exclude<FeedTab, 'all'>;
  role: string;
  text: string;
}
const names: Record<string, string> = {
  'run.created': 'Задача создана',
  'run.completed': 'Ответ готов к просмотру',
  'run.failed': 'Ошибка задачи',
  'run.cancelled': 'Задача остановлена',
  'run.paused': 'Задача приостановлена',
  'run.recovered': 'Восстановлена после перезапуска',
  'run.resumed': 'Задача продолжена',
  'model.requested': 'Запрос к модели',
  'model.completed': 'Ответ модели получен',
  'tool.started': 'Выполнение инструмента',
  'tool.succeeded': 'Инструмент выполнен',
  'tool.error': 'Ошибка инструмента',
  'tool.denied': 'Выполнение запрещено',
  'tool.cancelled': 'Инструмент отменён',
  'tool.unknown': 'Результат инструмента неизвестен',
  'agent.created': 'Подзадача создана',
  'agent.plan_created': 'Выбран способ работы',
  'agent.plan_rejected': 'План требует исправления',
  'agent.delegated': 'Задача делегирована',
  'agent.completed': 'Агент завершил работу',
  'agent.failed': 'Ошибка агента',
  'agent.child_joined': 'Получен результат подзадачи',
  'agent.handoff': 'Смена роли',
  'agent.children_collected': 'Получены результаты подзадач',
  'approval.requested': 'Нужно разрешение',
  'approval.resolved': 'Решение о разрешении сохранено',
  'approval.decided': 'Решение о разрешении сохранено',
  'approval.consumed': 'Однократное разрешение использовано',
  'context.compacted': 'Контекст сжат',
  'file.backup_created': 'Создана резервная копия',
  'file.applied': 'Файл изменён',
  'file.restored': 'Файл восстановлен',
};

/** Собирает курсорные страницы без дублей, сохраняя отдельные потоки параллельных ролей. */
export class TaskFeed {
  private readonly entries = new Map<string, FeedEntry>();
  private readonly seenEvents = new Set<number>();
  private readonly seenOutput = new Set<number>();
  private readonly attempts = new Map<string, number>();
  status?: TaskView;
  revision = 0;
  update(status: TaskView): void {
    if (this.status?.result !== status.result || this.status?.status !== status.status)
      this.revision++;
    this.status = status;
    for (const event of status.events) {
      if (this.seenEvents.has(event.seq)) continue;
      this.seenEvents.add(event.seq);
      this.addEvent(event);
    }
    for (const event of status.output.events) {
      if (this.seenOutput.has(event.seq)) continue;
      this.seenOutput.add(event.seq);
      this.addOutput(event);
    }
  }
  private add(entry: FeedEntry): void {
    this.revision++;
    this.entries.set(entry.id, {
      ...entry,
      text: terminalText(entry.text),
      role: terminalText(entry.role),
    });
  }
  private addEvent(event: StatusView['events'][number]): void {
    const data = (event.payload ?? {}) as Record<string, unknown>;
    const role = event.role ?? 'Harness',
      at = event.at ?? '';
    if (event.type !== 'agent.tools_completed')
      this.add({
        id: 'event-' + event.seq,
        at,
        role,
        kind: 'log',
        text: [
          event.title ?? [names[event.type] ?? event.type, data.tool].filter(Boolean).join(' · '),
          event.detail,
          event.type === 'agent.plan_created' ? data.reason : undefined,
          data.error,
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 1000),
      });
    if (event.preview) {
      if (event.preview.reasoning)
        this.add({
          id: 'legacy-thought-' + event.seq,
          at,
          role,
          kind: 'reasoning',
          text: event.preview.reasoning,
        });
      if (event.preview.text)
        this.add({
          id: 'legacy-text-' + event.seq,
          at,
          role,
          kind: 'text',
          text: event.preview.text,
        });
    }
  }
  private addOutput(event: OutputEvent): void {
    if (event.type === 'text' || event.type === 'reasoning') {
      const key =
        event.requestId + ':' + (this.attempts.get(event.requestId) ?? 0) + ':' + event.type;
      const previous = this.entries.get(key);
      this.add({
        id: key,
        at: previous?.at ?? event.at,
        role: event.role,
        kind: event.type,
        text: (previous?.text ?? '') + (event.text ?? ''),
      });
    } else if (['retry', 'failed', 'truncated'].includes(event.type)) {
      if (event.type === 'retry')
        this.attempts.set(event.requestId, (this.attempts.get(event.requestId) ?? 0) + 1);
      this.add({
        id: 'output-' + event.seq,
        at: event.at,
        role: event.role,
        kind: 'log',
        text: event.text ?? 'Ответ модели прерван; полученный фрагмент не является результатом.',
      });
    }
  }
  items(tab: FeedTab): FeedEntry[] {
    return [...this.entries.values()]
      .filter((entry) => tab === 'all' || tab === entry.kind)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}
