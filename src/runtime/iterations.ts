import { ApplicationError } from '../shared/application-error.js';
import { z } from 'zod';
import type { StateFiles } from '../sessions/ports.js';
import type { RunRecord } from '../sessions/types.js';
import { Serial } from '../shared/primitives.js';

const limitSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const settingsSchema = z
  .object({ schemaVersion: z.literal(1), defaultLimit: limitSchema })
  .strict();

export interface IterationStatus {
  defaultLimit: number;
  run?: {
    limit: number;
    used: number;
    total: number;
    remaining: number;
    pausedByLimit: boolean;
    editable: boolean;
  };
}

export class IterationLimitError extends Error {
  constructor(limit: number) {
    super('Достигнут предел ' + limit + ' шагов. Задача сохранена на паузе; можно продолжить.');
  }
}

/** Считает текущую порцию отдельно от общей истории, включая записи прежних версий. */
export function iterationProgress(run: RunRecord) {
  const limit = run.iterationLimit ?? run.config.value.limits.turns;
  const used = run.turns - (run.iterationStart ?? 0);
  return { limit, used, total: run.turns, remaining: Math.max(0, limit - used) };
}

/** Отклоняет предел, который не является положительным безопасным целым числом. */
export function validateIterationLimit(limit: number): void {
  if (!limitSchema.safeParse(limit).success)
    throw new Error('Предел шагов должен быть положительным целым числом.');
}

/** Не позволяет перезаписать настройку, изменённую после открытия формы. */
export function assertExpectedLimit(current: number, expected?: number): void {
  if (expected !== undefined && current !== expected)
    throw new ApplicationError(
      'STALE_PREVIEW',
      'Предел шагов уже изменился. Откройте настройки заново.',
    );
}

/** Хранит настройку новых задач; текущие запуски сохраняют собственный предел. */
export class IterationSettings {
  private readonly serial = new Serial();
  constructor(private readonly files: StateFiles) {}
  /** Читает сохранённый предел или значение конфига; повреждение не маскируется значением по умолчанию. */
  private async read(fallback: number): Promise<number> {
    try {
      const saved = await this.files.read('iteration-settings');
      return saved === undefined ? fallback : settingsSchema.parse(saved).defaultLimit;
    } catch {
      throw new Error('Не удалось прочитать настройки шагов в iteration-settings.json.');
    }
  }
  /** Возвращает предел новых запусков после ранее поставленных изменений. */
  defaultLimit(fallback: number): Promise<number> {
    return this.serial.run(() => this.read(fallback));
  }
  /** Атомарно сохраняет предел после проверки ожидаемого прежнего значения. */
  setDefault(limit: number, fallback: number, expectedLimit?: number): Promise<void> {
    validateIterationLimit(limit);
    return this.serial.run(async () => {
      assertExpectedLimit(await this.read(fallback), expectedLimit);
      await this.files.write('iteration-settings', { schemaVersion: 1, defaultLimit: limit });
    });
  }
}
