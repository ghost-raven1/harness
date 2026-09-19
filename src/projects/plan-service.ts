import type { z } from 'zod';
import { ApplicationError } from '../shared/application-error.js';
import { PolicyService } from '../policy/service.js';
import type { ProjectService } from './service.js';
import { planReadCommands, type PlanComparison } from './plan-schema.js';
import { inspectPlan } from './plan-validation.js';
import { ProjectPlanHistory } from './plan-history.js';
import { comparePlanValues } from './plan-comparison.js';

/** Чтение редакций и проверка черновика не меняют ревизию проекта и не запускают работу. */
export class ProjectPlanService {
  readonly history: ProjectPlanHistory;
  constructor(private readonly projects: ProjectService) {
    this.history = new ProjectPlanHistory(projects.store.directory);
  }
  /** Возвращает ошибки полей и закреплённые варианты выбора даже для неполного черновика. */
  async validatePlan(input: z.input<(typeof planReadCommands)['projects.validatePlan']['params']>) {
    const request = planReadCommands['projects.validatePlan'].params.parse(input);
    const project = await this.projects.store.get(request.projectId);
    const tools = this.projects.coordinator.options.tools;
    const result = inspectPlan(request.plan, project.config, tools, project);
    const stale =
      request.expectedRevision !== undefined && request.expectedRevision !== project.revision;
    const policy = new PolicyService();
    return {
      projectId: project.id,
      revision: project.revision,
      valid: !stale && !result.issues.length,
      stale,
      ...result,
      choices: {
        roles: Object.keys(project.config.value.roles).map((id) => ({ id, label: id })),
        tools: tools
          .definitions()
          .map((tool) => tool.name)
          .filter((name) =>
            Object.keys(project.config.value.roles).some((role) =>
              policy.canAdvertise(
                project.config.value,
                { role, authorityRoles: [project.config.value.defaultRole] },
                name,
              ),
            ),
          ),
      },
      completedStageIds: Object.values(project.stages)
        .filter((stage) => stage.status === 'completed')
        .map((stage) => stage.stageId),
    };
  }
  /** Выдаёт страницу метаданных; содержимое редакции читается отдельным запросом сравнения. */
  planVersions(input: z.input<(typeof planReadCommands)['projects.planVersions']['params']>) {
    const request = planReadCommands['projects.planVersions'].params.parse(input);
    return this.projects.coordinator.serial.run(async () => {
      const project = await this.projects.store.get(request.projectId);
      const all = [...(await this.history.versions(project))].reverse();
      const end = request.offset + request.limit;
      return {
        projectId: project.id,
        revision: project.revision,
        items: all
          .slice(request.offset, end)
          .map(({ offset: _offset, digest: _digest, ...entry }) => entry),
        total: all.length,
        ...(end < all.length ? { nextOffset: end } : {}),
        currentVersion: project.plan?.version,
        acceptedVersion: project.acceptedVersion,
      };
    });
  }
  /** По умолчанию сравнивает с принятой редакцией, иначе с предыдущей сохранённой. */
  comparePlans(
    input: z.input<(typeof planReadCommands)['projects.comparePlans']['params']>,
  ): Promise<PlanComparison> {
    const request = planReadCommands['projects.comparePlans'].params.parse(input);
    return this.projects.coordinator.serial.run(async () => {
      const project = await this.projects.store.get(request.projectId);
      if (request.plan && request.toVersion)
        throw new ApplicationError(
          'INVALID_REQUEST',
          'Выберите черновик или сохранённую редакцию для сравнения.',
        );
      const toVersion = request.plan ? undefined : (request.toVersion ?? project.plan?.version);
      const after =
        request.plan ?? (toVersion ? await this.history.read(project, toVersion) : undefined);
      if (!after) throw new ApplicationError('INVALID_PLAN', 'Сначала подготовьте план проекта.');
      const defaultFrom =
        project.acceptedVersion ??
        (request.plan
          ? project.plan?.version
          : toVersion && toVersion > 1
            ? toVersion - 1
            : undefined);
      const fromVersion = request.fromVersion ?? defaultFrom;
      const before = fromVersion ? await this.history.read(project, fromVersion) : undefined;
      const basis = request.plan
        ? 'draft'
        : request.fromVersion || request.toVersion
          ? 'explicit'
          : project.acceptedVersion
            ? 'accepted'
            : fromVersion
              ? 'previous'
              : 'first';
      const { version: _version, ...plain } = { version: toVersion, ...after };
      return {
        projectId: project.id,
        revision: project.revision,
        fromVersion,
        toVersion,
        basis,
        before,
        after: plain,
        changes: comparePlanValues(before, after),
      };
    });
  }
}
