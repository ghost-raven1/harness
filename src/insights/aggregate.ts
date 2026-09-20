import type { ActivityAggregate, ActivityEvent, RoleMetrics, UsageTotals } from './schema.js';

/** Отсутствующие сведения хранятся отдельно от подтверждённого нулевого расхода. */
export function emptyUsage(): UsageTotals {
  return {
    provider: { input: 0, output: 0, requests: 0 },
    estimate: { input: 0, output: 0, requests: 0 },
    unavailable: 0,
  };
}
/** Создаёт компактный накопитель, не удерживающий завершённые события. */
export function emptyAggregate(): ActivityAggregate {
  return {
    count: 0,
    activeMs: 0,
    pauseMs: 0,
    usage: emptyUsage(),
    retries: 0,
    partial: false,
    roles: [],
    open: [],
  };
}
/** Прибавляет только известный расход; source unavailable не превращается в ноль. */
export function addUsage(target: UsageTotals, usage: NonNullable<ActivityEvent['usage']>): void {
  if (usage.source === 'unavailable' || usage.input === null || usage.output === null)
    target.unavailable++;
  else {
    target[usage.source].input += usage.input;
    target[usage.source].output += usage.output;
    target[usage.source].requests++;
  }
}
/** Сворачивает поток фаз и оставляет лишь ограниченное число незакрытых интервалов. */
export function accumulate(state: ActivityAggregate, event: ActivityEvent): void {
  state.count = event.seq;
  state.firstAt ??= event.at;
  state.lastAt = event.at;
  if (event.type === 'gap') {
    state.partial = true;
    return;
  }
  let role = state.roles.find((item) => item.episodeId === event.episodeId);
  if (!role) {
    if (state.roles.length >= 4096) {
      state.partial = true;
      return;
    }
    role = {
      agentId: event.agentId,
      episodeId: event.episodeId,
      role: event.role,
      profile: event.profile,
      phases: {},
      usage: emptyUsage(),
      retries: 0,
      interrupted: 0,
    };
    state.roles.push(role);
  }
  if (event.type === 'start') {
    if (state.open.length < 4096) state.open.push(event);
    else state.partial = true;
  } else if (event.type === 'end') {
    const index = state.open.findIndex((item) => item.spanId === event.spanId);
    if (index < 0) {
      state.partial = true;
      return;
    }
    const start = state.open[index]!;
    state.open.splice(index, 1);
    if (
      start.phase !== event.phase ||
      start.episodeId !== event.episodeId ||
      start.processId !== event.processId ||
      event.durationMs === undefined
    ) {
      state.partial = true;
      return;
    }
    // Если фрагмента не было, прошедшее время не становится задержкой первого ответа.
    if (event.phase !== 'model.first_output' || event.outcome !== 'interrupted')
      applyDuration(state, role, event, event.durationMs);
    if (event.outcome === 'interrupted') {
      role.interrupted++;
      state.partial = true;
    }
  } else if (event.usage) {
    addUsage(state.usage, event.usage);
    addUsage(role.usage, event.usage);
  }
  if (event.type === 'start' && event.phase === 'model.retry') {
    state.retries++;
    role.retries++;
  }
}

/** Время дерева берётся из одного интервала run; длительности веток не суммируются с ним. */
function applyDuration(
  state: ActivityAggregate,
  role: RoleMetrics,
  event: ActivityEvent,
  duration: number,
): void {
  if (event.phase) role.phases[event.phase] = (role.phases[event.phase] ?? 0) + duration;
  if (event.phase === 'run') state.activeMs += duration;
  if (event.phase === 'pause') state.pauseMs += duration;
}

/** Добавляет текущую длительность только живых монотонных интервалов этого процесса. */
export function materialize(
  state: ActivityAggregate,
  elapsed: (spanId: string) => number | undefined,
): ActivityAggregate {
  const view = structuredClone(state);
  for (const event of view.open) {
    const role = view.roles.find((item) => item.episodeId === event.episodeId)!;
    const duration = event.spanId ? elapsed(event.spanId) : undefined;
    if (duration === undefined) {
      role.interrupted++;
      view.partial = true;
    } else applyDuration(view, role, event, duration);
  }
  return view;
}
