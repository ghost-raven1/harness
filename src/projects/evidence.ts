import type { z } from 'zod';
import type { RunCatalogEntry, SessionReader } from '../sessions/ports.js';
import type { BoundedArtifactReader } from '../sessions/artifact-reader.js';
import type { ProjectStore } from './store.js';
import type { ProjectWorkspace } from './workspace.js';
import type { ProjectRecord, ProjectReport } from './types.js';
import { ApplicationError } from '../shared/application-error.js';
import { hash } from '../shared/primitives.js';
import { checkReport } from './checks.js';
import { EvidenceCache, maximumEvidenceBytes, type CheckResult } from './evidence-cache.js';
import { projectReadInputs, type EvidenceCheck, type EvidenceReport } from './read-schema.js';
import { buildProjectReview } from './review.js';

interface Dependencies {
  projects: ProjectStore;
  sessions: SessionReader & BoundedArtifactReader & { readonly recoveryError?: string };
  workspace: ProjectWorkspace;
}
export interface CheckEvidence {
  check: EvidenceCheck;
  result?: CheckResult;
}

/** Читает доказательства через цепочку владельцев; пересказ модели не заменяет исходный вызов. */
export class ProjectEvidenceService {
  private readonly cache = new EvidenceCache();
  constructor(readonly dependencies: Dependencies) {}
  /** Удаление и общий сброс освобождают также уже декодированные результаты. */
  forget(projectId?: string): void {
    this.cache.forget(projectId);
  }
  /** Счётчики не содержат текстов задач или результатов команд. */
  cacheStats() {
    return this.cache.stats();
  }

  /** Страница проверок объединяет сохранённые отчёты и текущую детерминированную попытку. */
  async reports(raw: z.input<typeof projectReadInputs.reports>) {
    const input = projectReadInputs.reports.parse(raw);
    const project = await this.dependencies.projects.get(input.projectId);
    const selected = (await this.sourceReports(project)).filter(
      (report) =>
        (!input.phase || report.phase === input.phase) &&
        (!input.stageId || report.stageId === input.stageId) &&
        (input.attempt === undefined || report.attempt === input.attempt),
    );
    const items: EvidenceReport[] = [];
    const catalogue = new Map(this.dependencies.sessions.catalog(true).map((run) => [run.id, run]));
    for (const report of selected.slice(input.offset, input.offset + input.limit))
      items.push(await this.describe(project, report, catalogue));
    return {
      projectId: project.id,
      revision: project.revision,
      items,
      total: selected.length,
      ...(input.offset + items.length < selected.length
        ? { nextOffset: input.offset + items.length }
        : {}),
    };
  }

  /** Клиент получает только одну страницу; границы не разделяют суррогатную пару Unicode. */
  async checkOutput(raw: z.input<typeof projectReadInputs.checkOutput>) {
    const input = projectReadInputs.checkOutput.parse(raw);
    const project = await this.dependencies.projects.get(input.projectId);
    const report = (await this.sourceReports(project)).find(
      (value) =>
        value.id === input.reportId ||
        (input.reportId.startsWith('pending-') && value.runId === input.reportId.slice(8)),
    );
    if (!report) throw new ApplicationError('INVALID_REQUEST', 'Проверка не принадлежит проекту.');
    const evidence = await this.readCheck(project, report, input.checkId);
    const content = evidence.result?.[input.stream] ?? '';
    let start = Math.min(input.offset, content.length);
    if (
      start > 0 &&
      /[\uDC00-\uDFFF]/.test(content[start] ?? '') &&
      /[\uD800-\uDBFF]/.test(content[start - 1] ?? '')
    )
      start--;
    let end = Math.min(start + 16384, content.length);
    if (
      end < content.length &&
      /[\uD800-\uDBFF]/.test(content[end - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(content[end] ?? '')
    )
      end--;
    const truncated =
      evidence.result?.[input.stream === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated'] ?? false;
    return {
      projectId: project.id,
      reportId: report.id,
      checkId: input.checkId,
      stream: input.stream,
      state: evidence.check.state,
      exitCode: evidence.check.exitCode,
      evidence: evidence.check.evidence,
      reason: evidence.check.reason,
      text: content.slice(start, end),
      offset: start,
      ...(end < content.length ? { nextOffset: end } : {}),
      totalCharacters: content.length,
      truncated,
      complete: evidence.check.evidence === 'available' && !truncated && end === content.length,
    };
  }

  /** Приёмка использует сохранённые факты и свежий отпечаток без записи снимков. */
  async review(input: z.input<typeof projectReadInputs.review>) {
    const project = await this.dependencies.projects.get(
      projectReadInputs.review.parse(input).projectId,
    );
    return buildProjectReview(project, this);
  }

  /** Перед приёмкой повторно проверяет доказательства внутри очереди проекта. */
  async validateAccept(project: ProjectRecord): Promise<void> {
    const review = await buildProjectReview(project, this);
    if (!review.canAccept)
      throw new ApplicationError(
        review.freshness === 'changed' ? 'PROJECT_CHANGED' : 'PROJECT_CONFLICT',
        review.blockers.join('\n'),
      );
  }

  /** Формирует отчёт с проверенными источниками и привязкой к принятой версии. */
  async describe(
    project: ProjectRecord,
    report: ProjectReport,
    catalogue?: Map<string, RunCatalogEntry>,
  ): Promise<EvidenceReport> {
    const run = report.runId
      ? (
          catalogue ??
          new Map(this.dependencies.sessions.catalog(true).map((item) => [item.id, item]))
        ).get(report.runId)
      : undefined;
    const planVersion =
      run?.project?.projectId === project.id ? run.project.planVersion : undefined;
    const current =
      planVersion !== undefined
        ? planVersion === project.acceptedVersion
        : !report.runId &&
          !!report.stageId &&
          report.checks.length === 0 &&
          report.status === 'passed' &&
          project.plan?.stages.find((stage) => stage.id === report.stageId)?.verification.kind ===
            'manual' &&
          report.workspaceRevision === project.resultSnapshot?.digest &&
          project.stages[report.stageId]?.manualRevision === report.workspaceRevision;
    const checks: EvidenceCheck[] = [];
    for (let index = 0; index < report.checks.length; index++)
      checks.push((await this.readCheck(project, report, checkAddress(report, index))).check);
    const { checks: _checks, ...summary } = report;
    return { ...summary, checks, planVersion, current };
  }

  /** Только внутренний экспорт читает полный сохранённый результат; IPC отдаёт страницы. */
  async readCheck(
    project: ProjectRecord,
    report: ProjectReport,
    checkId: string,
  ): Promise<CheckEvidence> {
    const generation = this.cache.revision();
    let index = report.checks.findIndex(
      (check, index) => checkAddress(report, index) === checkId || check.invocationId === checkId,
    );
    if (index < 0 && report.checks.filter((check) => check.id === checkId).length === 1)
      index = report.checks.findIndex((check) => check.id === checkId);
    const saved = report.checks[index];
    if (!saved) throw new ApplicationError('INVALID_REQUEST', 'Команда отсутствует в отчёте.');
    const check: EvidenceCheck = {
      id: checkAddress(report, index),
      sourceId: saved.id,
      title: saved.title,
      command: saved.command,
      args: saved.args,
      state: state(saved.status),
      exitCode: saved.exitCode,
      evidence: ['started', 'not_run'].includes(saved.status) ? 'pending' : 'unavailable',
    };
    if (check.evidence === 'pending') return { check };
    try {
      if (!report.runId || !project.runIds.includes(report.runId) || !saved.invocationId)
        throw new Error('Нет связанного вызова проверки.');
      const run = await this.dependencies.sessions.load(report.runId);
      const invocation = run.invocations[saved.invocationId];
      if (
        run.deletedAt ||
        run.project?.projectId !== project.id ||
        run.project.kind !== 'checks' ||
        run.workspace !== project.workspace ||
        run.project.attempt !== report.attempt ||
        run.project.stageId !== report.stageId ||
        !invocation ||
        invocation.call.name !== 'process.exec' ||
        !run.projectChecks?.some(
          (call) =>
            call.id === invocation.call.id &&
            call.name === invocation.call.name &&
            call.arguments === invocation.call.arguments,
        )
      )
        throw new Error('Нарушена связь проекта и вызова проверки.');
      const args: unknown = JSON.parse(invocation.call.arguments);
      if (
        hash(args) !== hash({ command: saved.command, args: saved.args }) ||
        invocation.status !== saved.status
      )
        throw new Error('Вызов не соответствует принятой команде.');
      if (!invocation.result) throw new Error('Сохранённый вывод команды недоступен.');
      if (Buffer.byteLength(invocation.result) > maximumEvidenceBytes)
        throw new Error('Слишком большой результат.');
      const owned = run.artifacts.find(
        (artifact) =>
          artifact.callId === invocation.call.id && artifact.agentId === invocation.agentId,
      );
      const artifactId = saved.artifactId ?? owned?.id;
      let key: string, read: () => Promise<string>;
      if (artifactId !== undefined) {
        const envelope: unknown = JSON.parse(invocation.result);
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          !('artifactId' in envelope) ||
          envelope.artifactId !== artifactId ||
          !run.artifacts.some(
            (artifact) =>
              artifact.id === artifactId &&
              artifact.callId === invocation.call.id &&
              artifact.agentId === invocation.agentId,
          )
        )
          throw new Error('Артефакт не принадлежит вызову проверки.');
        const version = await this.dependencies.sessions.ownedArtifactVersion(
          run.id,
          artifactId,
          maximumEvidenceBytes,
        );
        key = [project.id, run.id, invocation.id, artifactId, version].join(':');
        read = () =>
          this.dependencies.sessions.readOwnedArtifact(run.id, artifactId, maximumEvidenceBytes);
      } else {
        if (saved.artifactId)
          throw new Error('Указанный артефакт отсутствует в результате вызова.');
        key = [project.id, run.id, invocation.id, hash(invocation.result)].join(':');
        read = async () => invocation.result!;
      }
      const result = await this.cache.get(project.id, key, read, generation);
      if (result.exitCode !== invocation.exitCode || result.exitCode !== saved.exitCode)
        throw new Error('Код завершения не совпадает с журналом.');
      check.evidence = 'available';
      check.stdoutTruncated = result.stdoutTruncated;
      check.stderrTruncated = result.stderrTruncated;
      return { check, result };
    } catch {
      check.reason = 'Исходный результат отсутствует, повреждён или принадлежит другому вызову.';
      if (check.state === 'completed') check.state = 'unavailable';
      return { check };
    }
  }

  /** Незавершённая команда видна до появления финального отчёта без подмены её исхода. */
  async sourceReports(project: ProjectRecord): Promise<ProjectReport[]> {
    const reports = [...project.reports];
    const intent = project.intent;
    if (
      intent?.kind === 'checks' &&
      intent.runId &&
      !reports.some((report) => report.runId === intent.runId)
    ) {
      try {
        const run = await this.dependencies.sessions.load(intent.runId);
        const report = checkReport(
          intent,
          run,
          intent.before ?? { digest: '', ref: '', files: 0, createdAt: '' },
        );
        report.id = 'pending-' + run.id;
        reports.push(report);
      } catch {
        /* Сохранённые отчёты остаются доступны при потере текущего запуска. */
      }
    }
    return reports;
  }
}

/** Статус выполнения отделён от наличия текстового доказательства. */
function state(status: string): EvidenceCheck['state'] {
  if (status === 'started') return 'running';
  if (status === 'succeeded' || status === 'error') return 'completed';
  if (status === 'denied' || status === 'cancelled' || status === 'unknown') return status;
  return 'not_run';
}

/** Критерии разных этапов могут иметь одинаковые имена; адрес результата всегда однозначен. */
function checkAddress(report: ProjectReport, index: number): string {
  const check = report.checks[index]!;
  return 'check-' + index + '-' + hash({ command: check.command, args: check.args }).slice(0, 12);
}
