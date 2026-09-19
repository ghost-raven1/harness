import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isWithin } from '../configuration/loader.js';
import { ApplicationError } from '../shared/application-error.js';
import type { WorkspaceAccess } from '../sessions/project-run.js';
import type { RunRecord } from '../sessions/types.js';

export interface WorkspaceBlocker {
  workspace: string;
  projectId?: string;
  unknown: boolean;
  active: boolean;
}
interface Reservation {
  workspace: string;
  requested: string;
  projectId?: string;
}

/** Реальные пути объединяют ссылки и разный регистр букв на Windows. */
function canonical(path: string): string {
  const value = realpathSync(path);
  if (!statSync(value).isDirectory())
    throw new ApplicationError('PROJECT_CHANGED', 'Рабочая папка недоступна.');
  return normalized(value);
}

/** Сравнивает входные пути теми же правилами регистра, что и реальные каталоги. */
function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Проверка включает вложенные проекты, но не соседние имена с одинаковым префиксом. */
function overlaps(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

/** Синхронная регистрация закрывает гонку между проверкой папки и созданием запуска. */
export class WorkspaceLeases implements WorkspaceAccess {
  private readonly projects = new Map<string, string>();
  private readonly reservations = new Map<symbol, Reservation>();

  constructor(private readonly blockers: () => WorkspaceBlocker[]) {}

  /** Закрепляет папку за проектом до запуска этапов и проверки результата. */
  acquire(projectId: string, workspace: string): void {
    const path = canonical(workspace);
    const current = this.projects.get(projectId);
    if (current && current !== path) this.conflict('Проект уже удерживает другую папку.');
    for (const [owner, folder] of this.projects)
      if (owner !== projectId && overlaps(path, folder)) this.conflict();
    for (const reservation of this.reservations.values())
      if (reservation.projectId !== projectId && overlaps(path, reservation.workspace))
        this.conflict();
    this.checkBlockers(path, projectId);
    this.projects.set(projectId, path);
  }

  /** Освобождение допустимо только после завершения исполнителей управляемого проекта. */
  release(projectId: string): void {
    if (!this.projects.has(projectId)) return;
    if ([...this.reservations.values()].some((item) => item.projectId === projectId))
      this.conflict('Сначала дождитесь остановки задачи проекта.');
    this.projects.delete(projectId);
  }

  /** Резервирует доступ до первой асинхронной операции; возвращает идемпотентное освобождение. */
  reserve(input: { workspace: string; projectId?: string }): () => void {
    const workspace = canonical(input.workspace);
    this.checkOwner(workspace, input.projectId);
    this.checkBlockers(workspace, input.projectId);
    const token = Symbol();
    this.reservations.set(token, { ...input, workspace, requested: normalized(input.workspace) });
    return () => {
      this.reservations.delete(token);
    };
  }

  /** Повторяет проверку непосредственно перед мутацией, после ожидания очереди инструментов. */
  assertWrite(run: RunRecord): void {
    let workspace: string;
    try {
      workspace = canonical(run.workspace);
    } catch (error) {
      throw new ApplicationError('PROJECT_CHANGED', 'Рабочая папка изменилась или недоступна.', {
        cause: error,
      });
    }
    const projectId = run.project?.projectId;
    const reserved = [...this.reservations.values()].some(
      (item) =>
        item.projectId === projectId &&
        item.workspace === workspace &&
        (item.requested === normalized(run.workspace) ||
          item.workspace === normalized(run.workspace)),
    );
    if (!reserved) this.conflict('Доступ задачи к рабочей папке уже освобождён или изменился.');
    this.checkOwner(workspace, projectId);
    this.checkBlockers(workspace, projectId);
  }

  /** Общий сброс не должен начинаться при удерживаемой папке или создаваемом запуске. */
  busy(): boolean {
    return this.projects.size > 0 || this.reservations.size > 0;
  }

  /** Управляемая задача использует исключительно папку принадлежащего ей проекта. */
  private checkOwner(workspace: string, projectId?: string): void {
    if (projectId && this.projects.get(projectId) !== workspace)
      this.conflict('Проект не удерживает эту рабочую папку.');
    for (const [owner, path] of this.projects)
      if (owner !== projectId && overlaps(workspace, path)) this.conflict();
  }

  /** Неизвестный исход блокирует повторные записи даже после перезапуска сервиса. */
  private checkBlockers(workspace: string, projectId?: string): void {
    for (const blocker of this.blockers()) {
      if (!blocker.unknown && (!blocker.active || blocker.projectId === projectId)) continue;
      let path: string;
      try {
        path = canonical(blocker.workspace);
      } catch {
        path = normalized(blocker.workspace);
      }
      if (overlaps(workspace, path))
        this.conflict(
          blocker.unknown
            ? 'В этой папке есть операция с неизвестным результатом. Сначала проверьте её.'
            : undefined,
        );
    }
  }

  /** Один стабильный код позволяет интерфейсу предложить ожидание или выбор другой папки. */
  private conflict(message = 'Папка занята другой задачей или проектом.'): never {
    throw new ApplicationError('PROJECT_CONFLICT', message);
  }
}
