import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { hash } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { HistoryCache } from '../sessions/cache.js';
import { assertRealDirectory, optionalJson, writeDerivedText } from '../sessions/files.js';
import { scanJournal } from '../sessions/journal.js';
import { projectIdentifier, validateProjectEvent } from './validation.js';
import { planVersionSummarySchema } from './plan-schema.js';
import type { ProjectRecord, VersionedPlan } from './types.js';

const entrySchema = planVersionSummarySchema.extend({
  offset: z.number().int().nonnegative(),
  digest: z.string(),
});
const indexSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: projectIdentifier,
  revision: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  ctimeMs: z.number(),
  entries: z.array(entrySchema),
});
type PlanIndex = z.infer<typeof indexSchema>;

/** Производный индекс хранит только смещения версий, а не копии планов и конфигураций. */
export class ProjectPlanHistory {
  private readonly cache = new HistoryCache<PlanIndex>(4 * 1024 * 1024);
  constructor(private readonly directory: string) {}

  /** Восстанавливает повреждённый или устаревший индекс из проверенного журнала. */
  async versions(project: ProjectRecord): Promise<PlanIndex['entries']> {
    return (await this.index(project)).entries;
  }
  /** Читает единственную исходную запись нужной редакции по точному смещению. */
  async read(project: ProjectRecord, version: number): Promise<VersionedPlan> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const index = await this.index(project, attempt > 0);
      const entry = index.entries.find((item) => item.version === version);
      if (!entry)
        throw new ApplicationError('INVALID_PLAN', 'Сохранённая версия плана не найдена.');
      try {
        for await (const row of scanJournal(this.source(project.id), entry.offset)) {
          const event = validateProjectEvent(row.value, entry.revision, project.id);
          if (event.state.plan?.version === version && hash(event.state.plan) === entry.digest)
            return event.state.plan;
          break;
        }
      } catch (error) {
        if (attempt > 0) throw error;
        // Повреждённое смещение не считается повреждением исходного журнала до пересоздания.
      }
    }
    throw new ApplicationError(
      'STORAGE_UNAVAILABLE',
      'Не удалось прочитать подтверждённую версию плана.',
    );
  }
  /** Каскад удаления очищает и производную память выбранного проекта. */
  forget(projectId: string): void {
    this.cache.delete(projectId);
  }
  private source(projectId: string): string {
    return join(this.directory, 'project-records', projectIdentifier.parse(projectId) + '.jsonl');
  }
  private async index(project: ProjectRecord, rebuild = false): Promise<PlanIndex> {
    const source = this.source(project.id);
    await assertRealDirectory(join(this.directory, 'project-records'));
    const meta = await lstat(source);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1)
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Недоступна история редакций проекта.');
    const matches = (value: PlanIndex) =>
      value.projectId === project.id &&
      value.revision === project.revision &&
      value.size === meta.size &&
      value.mtimeMs === meta.mtimeMs &&
      value.ctimeMs === meta.ctimeMs;
    const path = join(this.directory, 'project-index', project.id + '.plans.json');
    if (!rebuild) {
      const cached = this.cache.get(project.id);
      if (cached && matches(cached)) return cached;
      try {
        await assertRealDirectory(join(this.directory, 'project-index'));
        const value = z
          .object({ data: indexSchema, checksum: z.string() })
          .parse(await optionalJson(path));
        if (
          hash(value.data) === value.checksum &&
          matches(value.data) &&
          this.validEntries(value.data, project)
        ) {
          this.cache.set(project.id, value.data);
          return value.data;
        }
      } catch {
        /* Ошибка производного файла требует пересоздания, а не ремонта исходной истории. */
      }
    }
    const entries: PlanIndex['entries'] = [];
    const accepted = new Set<number>();
    let seq = 0;
    for await (const row of scanJournal(source)) {
      const event = validateProjectEvent(row.value, ++seq, project.id);
      const plan = event.state.plan;
      if (event.state.acceptedVersion) accepted.add(event.state.acceptedVersion);
      if (!plan) continue;
      const previous = entries.at(-1);
      if (previous?.version === plan.version) {
        if (previous.digest !== hash(plan)) throw new Error('PROJECT_PLAN_VERSION_REWRITTEN');
        continue;
      }
      if (plan.version !== (previous?.version ?? 0) + 1)
        throw new Error('PROJECT_PLAN_VERSION_SEQUENCE');
      entries.push({
        version: plan.version,
        revision: seq,
        createdAt: event.at,
        accepted: false,
        stageCount: plan.stages.length,
        offset: row.offset,
        digest: hash(plan),
      });
    }
    if (seq !== project.revision)
      throw new ApplicationError(
        'PROJECT_CONFLICT',
        'Проект изменился во время чтения редакций. Повторите просмотр.',
      );
    for (const entry of entries) entry.accepted = accepted.has(entry.version);
    const current = await stat(source);
    const data: PlanIndex = {
      schemaVersion: 1,
      projectId: project.id,
      revision: seq,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
      entries,
    };
    this.cache.set(project.id, data);
    try {
      await assertRealDirectory(join(this.directory, 'project-index'));
      await writeDerivedText(path, JSON.stringify({ data, checksum: hash(data) }));
    } catch {
      /* Чтение подтверждённой версии остаётся доступным без записываемого индекса. */
    }
    return data;
  }
  private validEntries(index: PlanIndex, project: ProjectRecord): boolean {
    return (
      index.entries.length === (project.plan?.version ?? 0) &&
      index.entries.every(
        (entry, position, entries) =>
          entry.version === position + 1 &&
          entry.revision <= project.revision &&
          entry.offset < index.size &&
          (position === 0 ||
            (entry.revision > entries[position - 1]!.revision &&
              entry.offset > entries[position - 1]!.offset)),
      )
    );
  }
}
