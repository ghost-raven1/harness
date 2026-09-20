import type { ActivityEvent, RunInsights, UsageTotals } from '../../../insights/schema.js';
import { labels } from '../../ui.js';
import type { TextTab } from '../text-reader.js';

type Agent = RunInsights['agents'][number];
export const phaseLabels: Record<NonNullable<ActivityEvent['phase']>, string> = {
  run: 'Выполнение задачи',
  pause: 'Пауза',
  agent: 'Работа специалиста',
  planning: 'Подготовка плана',
  compaction: 'Сжатие контекста',
  'model.queue': 'Очередь модели',
  'model.request': 'Запрос к модели',
  'model.first_output': 'Ожидание первого ответа',
  'model.retry': 'Повтор запроса',
  'tool.queue': 'Очередь инструмента',
  'tool.execute': 'Выполнение инструмента',
  approval: 'Ожидание разрешения',
  children: 'Ожидание специалистов',
};
export const completenessLabels: Record<RunInsights['completeness'], string> = {
  complete: 'Сохранённые метрики доступны',
  partial: 'Метрики неполные · часть работы не зарегистрирована',
  unavailable: 'Подробные метрики не записывались для этой задачи',
};

/** Продолжительность не смешивает миллисекунды метрик с системным временем клиента. */
export function duration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes} мин ${seconds % 60} с`
    : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

/** Оценка и неизвестное потребление не выдаются за токены, подтверждённые провайдером. */
export function usageText(usage: UsageTotals): string {
  return [
    `Провайдер: ${usage.provider.input} вход / ${usage.provider.output} выход · запросов ${usage.provider.requests}`,
    `Оценка: ${usage.estimate.input} вход / ${usage.estimate.output} выход · запросов ${usage.estimate.requests}`,
    `Без данных о токенах: ${usage.unavailable}`,
  ].join('\n');
}

/** Дерево опирается на parentId; одинаковые роли остаются разными специалистами. */
export function agentTree(agents: Agent[]): Array<{ agent: Agent; depth: number }> {
  const ids = new Set(agents.map((agent) => agent.id));
  const visited = new Set<string>();
  const result: Array<{ agent: Agent; depth: number }> = [];
  const visit = (agent: Agent, depth: number): void => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    result.push({ agent, depth: agent.depth ?? depth });
    for (const child of agents) if (child.parentId === agent.id) visit(child, depth + 1);
  };
  for (const agent of agents) if (!agent.parentId || !ids.has(agent.parentId)) visit(agent, 0);
  for (const agent of agents) visit(agent, 0);
  return result;
}

/** Состояние агента и фаза показываются отдельно: ожидание не выглядит занятым инструментом. */
export function agentSummary(agent: Agent, measured = true): string {
  // Вложенные интервалы run/agent/request не должны заслонять фактическое ожидание.
  const priority: Agent['phases'] = [
    'pause',
    'approval',
    'children',
    'model.retry',
    'model.queue',
    'tool.queue',
    'tool.execute',
    'compaction',
    'planning',
    'model.first_output',
    'model.request',
    'agent',
    'run',
  ];
  const phase = priority.find((value) => agent.phases.includes(value));
  return [
    labels[agent.status] ?? agent.status,
    phase ? phaseLabels[phase] : '',
    measured ? duration(agent.elapsedMs) : 'время не записывалось',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Итоги задачи не суммируют перекрывающиеся интервалы параллельных исполнителей. */
export function runSummary(insights: RunInsights): string {
  return [
    labels[insights.status] ?? insights.status,
    insights.completeness === 'unavailable'
      ? 'Время работы и пауз не записывалось'
      : `Работа: ${duration(insights.activeMs)} · паузы: ${duration(insights.pauseMs)}`,
    `Профиль: ${insights.profile} · специалистов: ${insights.agentTotal ?? insights.agents.length}`,
    completenessLabels[insights.completeness],
  ].join('\n');
}

/** Журнал выводит только полученные события и явный исход, без выдуманных объяснений модели. */
export function activityText(events: ActivityEvent[]): string {
  const outcomes = {
    completed: 'завершено',
    failed: 'ошибка',
    cancelled: 'отменено',
    interrupted: 'прервано',
  };
  const types = { start: 'Начало', end: 'Конец', usage: 'Токены', gap: 'Пробел в метриках' };
  return (
    events
      .map((event) =>
        [
          `${event.at} · ${types[event.type]}${event.phase ? ' · ' + phaseLabels[event.phase] : ''}`,
          `Роль: ${event.role} · профиль: ${event.profile}`,
          event.outcome ? outcomes[event.outcome] : '',
          event.durationMs === undefined ? '' : 'Длительность: ' + duration(event.durationMs),
          event.requestId ? 'Запрос: ' + event.requestId : '',
          event.invocationId ? 'Инструмент: ' + event.invocationId : '',
          event.usage
            ? `Токены: ${event.usage.input ?? 'нет данных'} вход / ${event.usage.output ?? 'нет данных'} выход · ${event.usage.source === 'provider' ? 'провайдер' : event.usage.source === 'estimate' ? 'оценка' : 'неизвестно'}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      )
      .join('\n\n') || 'Событий на этой странице пока нет.'
  );
}

/** История смены ролей остаётся разбитой по эпизодам, даже при одном agentId. */
export function specialistTabs(insights: RunInsights, agentId: string, journal: string): TextTab[] {
  const agent = insights.agents.find((item) => item.id === agentId);
  if (!agent)
    return [
      { id: 'missing', label: 'Специалист', text: 'Специалист больше не доступен в этой задаче.' },
    ];
  const episodes = insights.roles.filter((item) => item.agentId === agentId);
  return [
    {
      id: 'task',
      label: 'Задание',
      text: [
        agent.role,
        `Задача: ${labels[insights.status] ?? insights.status}`,
        agentSummary(agent, insights.completeness !== 'unavailable'),
        `Профиль: ${agent.profile}`,
        agent.reason,
        '\nЗадание\n' + agent.task,
        agent.taskTruncated ? 'Показан фрагмент задания.' : '',
        `\nID: ${agent.id}`,
        agent.parentId ? 'Родитель: ' + agent.parentId : 'Корневой специалист',
      ]
        .filter(Boolean)
        .join('\n'),
    },
    {
      id: 'metrics',
      label: 'Время и токены',
      text: [
        completenessLabels[insights.completeness],
        'Интервалы могут пересекаться; их сумма не равна времени задачи.',
        ...(insights.rolesTruncated
          ? [
              'Список эпизодов сокращён. Старые события доступны во вкладке «Журнал»; Enter — страницы.',
            ]
          : []),
        ...episodes.map((episode) =>
          [
            `\nРоль: ${episode.role} · профиль: ${episode.profile}\nЭпизод: ${episode.episodeId}`,
            ...Object.entries(episode.phases).map(
              ([phase, elapsed]) =>
                `${phaseLabels[phase as keyof typeof phaseLabels]}: ${duration(elapsed)}`,
            ),
            `Повторов: ${episode.retries} · прерванных интервалов: ${episode.interrupted}`,
            usageText(episode.usage),
          ].join('\n'),
        ),
        ...(!episodes.length ? ['Метрики этого специалиста не сохранены.'] : []),
      ].join('\n'),
    },
    { id: 'activity', label: 'Журнал', text: journal },
    {
      id: 'result',
      label: 'Результат',
      text: [
        agent.result && (agent.resultTruncated || agent.resultCursor)
          ? `Символы ${(agent.resultCursor ?? 0) + 1}–${(agent.resultCursor ?? 0) + agent.result.length} из ${agent.resultLength ?? 'неизвестно'}${agent.resultTruncated ? ' · продолжение через Enter' : ''}`
          : '',
        agent.result || 'Результат ещё не сохранён.',
        agent.error ? '\nОшибка\n' + agent.error : '',
        agent.errorTruncated ? 'Показан фрагмент ошибки.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}
