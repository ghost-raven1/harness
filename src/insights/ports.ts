/** Технические фазы не содержат тексты пользователя и параметры инструментов. */
export type ActivityPhase =
  | 'run'
  | 'pause'
  | 'agent'
  | 'planning'
  | 'compaction'
  | 'model.queue'
  | 'model.request'
  | 'model.first_output'
  | 'model.retry'
  | 'tool.queue'
  | 'tool.execute'
  | 'approval'
  | 'children';
export type ActivityOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type UsageSource = 'provider' | 'estimate' | 'unavailable';
export interface ObservedUsage {
  input: number | null;
  output: number | null;
  source: UsageSource;
}
export interface ObservationDetails {
  requestId?: string;
  invocationId?: string;
  attempt?: number;
}
export interface ObservationSpan {
  /** Завершает интервал один раз по монотонным часам. */
  end(outcome?: ActivityOutcome): void;
}
export interface ExecutionObservation {
  /** Открывает интервал; наблюдение не меняет результат исполняемой операции. */
  begin(phase: ActivityPhase, details?: ObservationDetails): ObservationSpan;
  /** Сохраняет единственный итог расхода конкретной попытки запроса. */
  usage(usage: ObservedUsage, details?: ObservationDetails): void;
}
export interface ObservationScope extends ObservationDetails {
  runId: string;
  agentId: string;
  role: string;
  profile: string;
}
export interface ExecutionObserver {
  /** Завершает накопленную запись перед освобождением исполнителя. */
  flush?(): Promise<void>;
  /** Освобождает принадлежность участков завершённого дерева; открытые интервалы сохраняются. */
  release?(runId: string): void;
  /** Связывает фазы с закреплёнными ролью и профилем. */
  scope(scope: ObservationScope): ExecutionObservation;
}
export const noObservation: ExecutionObservation = {
  begin: () => ({ end: () => undefined }),
  usage: () => undefined,
};
