import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson, optionalJson } from '../sessions/files.js';
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

export function validateIterationLimit(limit: number): void {
  if (!limitSchema.safeParse(limit).success)
    throw new Error('Предел шагов должен быть положительным целым числом.');
}

export function assertExpectedLimit(current: number, expected?: number): void {
  if (expected !== undefined && current !== expected)
    throw new Error('Предел шагов уже изменился. Откройте настройки заново.');
}

/** Хранит настройку новых задач; текущие запуски сохраняют собственный предел. */
export class IterationSettings {
  private readonly serial = new Serial();
  private readonly path: string;
  constructor(directory: string) {
    this.path = join(directory, 'iteration-settings.json');
  }
  private async read(fallback: number): Promise<number> {
    try {
      const saved = await optionalJson(this.path);
      return saved === undefined ? fallback : settingsSchema.parse(saved).defaultLimit;
    } catch {
      throw new Error('Не удалось прочитать настройки шагов в iteration-settings.json.');
    }
  }
  defaultLimit(fallback: number): Promise<number> {
    return this.serial.run(() => this.read(fallback));
  }
  setDefault(limit: number, fallback: number, expectedLimit?: number): Promise<void> {
    validateIterationLimit(limit);
    return this.serial.run(async () => {
      assertExpectedLimit(await this.read(fallback), expectedLimit);
      await atomicJson(this.path, { schemaVersion: 1, defaultLimit: limit });
    });
  }
}
