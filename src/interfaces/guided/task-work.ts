import type { StatusView, TaskView } from '../types.js';
import type { OutputEvent } from '../../sessions/output.js';
import type { WorkIndicator } from './work-indicator.js';

/** Состояние запуска имеет приоритет над последним событием завершившегося исполнителя. */
export function taskWork(status: StatusView | undefined): WorkIndicator | undefined {
  if (!status) return { kind: 'busy', label: 'Загружаю задачу' };
  if (status.recoveryRequired) return { kind: 'error', label: 'Сбой записи · нужен перезапуск' };
  if (status.unknownInvocations.length)
    return { kind: 'error', label: 'Нужно проверить исход операции' };
  if (status.deletedAt) return undefined;
  if (status.status === 'paused')
    return {
      kind: 'waiting',
      label:
        status.pauseReason === 'provider'
          ? 'Пауза: ограничение провайдера'
          : 'Работа приостановлена',
    };
  if (status.status === 'awaiting_approval' || status.approvals.length)
    return { kind: 'waiting', label: 'Нужно ваше разрешение' };
  if (status.status === 'running') return { kind: 'busy', label: 'Задача выполняется' };
  return undefined;
}

interface Operation {
  agentId: string;
  since?: string;
  label: string;
}
const toolLabels: Record<string, string> = {
  'fs.read': 'Читаю файл',
  'fs.list': 'Просматриваю папку',
  'fs.search': 'Ищу в файлах',
  'fs.write': 'Записываю файл',
  'process.exec': 'Выполняю команду',
  'agents.await': 'Ожидаю специалистов',
  'agents.delegate': 'Передаю задачу специалисту',
  'agents.handoff': 'Переключаю специалиста',
};

/** Сводит уже загруженные события параллельных исполнителей без новых запросов к сервису. */
export class TaskWork {
  private readonly models = new Map<string, Operation>();
  private readonly tools = new Map<string, Operation>();

  /** Начало и результат инструмента связываются по ID, а не по порядку параллельных вызовов. */
  event(event: StatusView['events'][number]): void {
    const data = event.payload as Record<string, unknown> | null;
    if (!data || typeof data.invocationId !== 'string') return;
    if (event.type === 'tool.started' && typeof data.agentId === 'string') {
      this.tools.set(data.invocationId, {
        agentId: data.agentId,
        since: event.at,
        label: toolLabels[String(data.tool)] ?? 'Выполняю инструмент',
      });
    } else if (event.type.startsWith('tool.')) this.tools.delete(data.invocationId);
  }

  /** Поток различает ожидание первого токена, получение ответа и повтор подключения. */
  output(event: OutputEvent): void {
    if (event.type === 'started') {
      this.models.set(event.requestId, {
        agentId: event.agentId,
        since: event.at,
        label: 'Ожидаю ответ модели',
      });
    } else if (event.type === 'completed' || event.type === 'failed')
      this.models.delete(event.requestId);
    else {
      const current = this.models.get(event.requestId);
      if (current && event.type !== 'truncated')
        current.label =
          event.type === 'retry' ? 'Повтор подключения к модели' : 'Получаю ответ модели';
    }
  }

  /** Незагруженный хвост истории не выдаётся за текущую работу; завершённые ветки исключаются. */
  view(status: TaskView | undefined): WorkIndicator | undefined {
    const base = taskWork(status);
    if (!status || base?.kind !== 'busy') return base;
    if (status.hasMoreEvents || status.output.hasMore)
      return { kind: 'busy', label: 'Загружаю журнал задачи' };
    const active = new Set(
      status.agents
        .filter((agent) => ['running', 'waiting'].includes(agent.status))
        .map((agent) => agent.id),
    );
    const models = [...this.models.values()].filter((item) => active.has(item.agentId));
    const tools = [...this.tools.values()].filter((item) => active.has(item.agentId));
    const operations = [...models, ...tools];
    if (!operations.length) return base;
    const since = operations
      .map((item) => item.since)
      .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
      .sort()[0];
    const label =
      models.length && tools.length
        ? `Модели: ${models.length} · инструменты: ${tools.length}`
        : models.length > 1
          ? `Работают модели: ${models.length}`
          : tools.length > 1
            ? `Инструментов в работе: ${tools.length}`
            : operations[0]!.label;
    return { kind: 'busy', label, since };
  }
}
