import { ApplicationError } from '../shared/application-error.js';
import { id, message } from '../shared/primitives.js';
import type { ProjectService } from './service.js';
import type { ProjectInput, ProjectRecord } from './types.js';
import { correctionMessage } from './checks.js';

/** Управление проектом сохраняет намерение человека до обращения к исполнителям. */
export class ProjectControls {
  constructor(private readonly service: ProjectService) {}
  /** Сохраняет намерение паузы до остановки исполнителей. */
  pause(input: ProjectInput<'pause'>) {
    return this.service.mutate('pause', input, async (project) => {
      if (!['running', 'planning'].includes(project.status))
        throw new ApplicationError('PROJECT_CONFLICT', 'Проект сейчас не выполняется.');
      project.status = 'pausing';
      project.reason = 'Завершаем текущий обмен с инструментами.';
      project = await this.service.coordinator.save(
        project,
        'project.pause_requested',
        project.reason,
      );
      if (project.intent?.runId && this.service.runs.busy(project.intent.runId)) {
        await this.service.runs.pause(project.intent.runId);
        return project;
      }
      project.status = 'paused';
      return this.service.coordinator.checkpoint(project);
    });
  }
  /** Продолжает закреплённую попытку после проверки файлов и неизвестных операций. */
  resume(input: ProjectInput<'resume'>) {
    return this.service.mutate('resume', input, async (project, request) => {
      if (project.status !== 'paused')
        throw new ApplicationError('PROJECT_CONFLICT', 'Продолжить можно проект на паузе.');
      this.service.requireIdle(project);
      if (
        ['BASELINE_FAILED', 'MANUAL_CHECK', 'FINAL_MANUAL_CHECK'].includes(project.reasonCode ?? '')
      )
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Сначала примите решение по проверкам или новой версии плана.',
        );
      for (const runId of project.runIds) {
        const run = await this.service.runs.inspect(runId);
        if (
          Object.values(run.invocations).some(
            (call) => call.status === 'unknown' || call.status === 'started',
          )
        )
          throw new ApplicationError(
            'UNKNOWN_OUTCOME',
            'Сначала проверьте неизвестный результат операции.',
          );
      }
      this.service.leases.acquire(project.id, project.workspace);
      try {
        const current = await this.service.coordinator.capture(project);
        this.service.coordinator.changes.external(project, current);
        if (
          project.checkpoint &&
          current.digest !== project.checkpoint.digest &&
          (!request.acceptChanges || project.externalSnapshot?.digest !== current.digest)
        ) {
          project.externalSnapshot = current;
          project.reasonCode = 'PROJECT_CHANGED';
          project.reason =
            'Файлы изменились после паузы. Просмотрите внешние изменения и подтвердите продолжение.';
          delete project.receipts[request.requestKey];
          project = await this.service.coordinator.save(
            project,
            'project.external_changes',
            project.reason,
          );
          throw new ApplicationError(
            'PROJECT_CHANGED',
            'Файлы изменились после паузы. Проверьте изменения и подтвердите продолжение с повторной проверкой.',
          );
        }
        delete project.externalSnapshot;
        project.checkpoint = current;
        delete project.resultSnapshot;
        project.status = project.intent?.kind === 'planning' ? 'planning' : 'running';
        delete project.reason;
        delete project.reasonCode;
        project = await this.service.coordinator.save(
          project,
          'project.resumed',
          'Продолжение подтверждено человеком.',
        );
        project = await this.deliverMessages(project);
        if (project.intent) {
          if (!project.intent.runId) return this.service.coordinator.dispatchIntent(project);
          const run = await this.service.runs.inspect(project.intent.runId);
          if (run.status === 'paused') {
            this.service.coordinator.changes.continued(project, current);
            project = await this.service.coordinator.save(
              project,
              'project.continuation_prepared',
              'Продолжение текущей попытки закреплено.',
            );
            await this.service.runs.resume(run.id);
            return project;
          }
          if (
            run.status === 'completed' ||
            (project.intent.kind === 'checks' && run.status === 'failed')
          ) {
            await this.service.coordinator.settled(run.id);
            return this.service.store.get(project.id);
          }
          if (project.intent.kind === 'planning') {
            const previous = project.intent;
            delete project.intent;
            return this.service.coordinator.start(project, {
              kind: 'planning',
              attempt: previous.attempt + 1,
              message: previous.message,
            });
          }
          const stageId = project.intent.stageId;
          delete project.intent;
          if (stageId) project.stages[stageId]!.status = 'blocked';
        }
        const blocked = project.plan?.stages.find(
          (stage) => project.stages[stage.id]?.status === 'blocked',
        );
        if (blocked) {
          const state = project.stages[blocked.id]!;
          state.attempt++;
          return this.service.coordinator.startStage(
            project,
            blocked,
            project.reports.at(-1)
              ? correctionMessage(project.reports.at(-1)!)
              : 'Продолжи незавершённый этап после паузы.',
          );
        }
        return this.service.coordinator.advance(project);
      } catch (error) {
        if (!project.intent?.runId || !this.service.runs.busy(project.intent.runId))
          this.service.leases.release(project.id);
        throw error;
      }
    });
  }
  /** Останавливает дерево, сохраняя уже выполненные изменения. */
  cancel(input: ProjectInput<'cancel'>) {
    return this.service.mutate('cancel', input, async (project) => {
      if (project.status === 'completed')
        throw new ApplicationError('PROJECT_CONFLICT', 'Результат уже принят.');
      project.status = 'cancelled';
      project.reason = 'Проект остановлен. Выполненные изменения сохранены.';
      project.reasonCode = 'CANCELLED';
      project = await this.service.coordinator.save(
        project,
        'project.cancel_requested',
        project.reason,
      );
      for (const runId of project.runIds)
        if (this.service.runs.busy(runId)) await this.service.runs.cancel(runId);
      return this.service.coordinator.checkpoint(project);
    });
  }
  /** Закрепляет уточнение за конкретным этапом и ключом доставки. */
  message(input: ProjectInput<'message'>) {
    return this.service.mutate('message', input, async (project, request) => {
      if (
        project.intent?.kind !== 'stage' ||
        project.intent.stageId !== request.stageId ||
        !project.intent.runId
      )
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Этап сменился во время ввода. Сообщение сохраните и выберите нужный этап заново.',
        );
      (project.messages ??= []).push({
        requestKey: request.requestKey,
        runId: project.intent.runId,
        stageId: request.stageId,
        message: request.message,
      });
      project = await this.service.coordinator.save(
        project,
        'project.message_prepared',
        'Уточнение закреплено за этапом ' + request.stageId,
      );
      return this.deliverMessages(project, request.requestKey);
    });
  }
  /** Исходящий ящик сохраняет адрес этапа; повторная доставка использует ключ runtime. */
  async deliverMessages(project: ProjectRecord, requestKey?: string): Promise<ProjectRecord> {
    const rejected = project.messages?.find(
      (item) => item.requestKey === requestKey && item.rejected,
    );
    if (rejected) throw new ApplicationError('PROJECT_CONFLICT', rejected.rejected!);
    while (true) {
      const item = project.messages?.find((message) => !message.sent && !message.rejected);
      if (!item) break;
      try {
        await this.service.runs.sendMessage({
          runId: item.runId,
          message: item.message,
          requestKey: item.requestKey,
        });
      } catch (error) {
        const run = await this.service.runs.inspect(item.runId);
        if (
          ['completed', 'failed', 'cancelled'].includes(run.status) &&
          !run.userMessages?.some((entry) => entry.requestKey === item.requestKey)
        ) {
          item.rejected =
            'Этап завершился. Сообщение не отправлено; сохранённый текст можно отправить отдельным действием.';
          await this.service.coordinator.save(project, 'project.message_rejected', item.rejected);
          throw new ApplicationError('PROJECT_CONFLICT', item.rejected, { cause: error });
        }
        throw new Error('Не удалось подтвердить доставку уточнения: ' + message(error), {
          cause: error,
        });
      }
      item.sent = true;
      project = await this.service.coordinator.save(
        project,
        'project.message_sent',
        'Уточнение передано этапу ' + item.stageId,
      );
    }
    return project;
  }
  /** Сохраняет оценку человека для показанного состояния файлов. */
  manualCheck(input: ProjectInput<'manualCheck'>) {
    return this.service.mutate('manualCheck', input, async (project, request) => {
      this.service.requireIdle(project);
      const stage = project.plan?.stages.find((item) => item.id === request.stageId);
      if (
        stage?.verification.kind !== 'manual' ||
        (project.reasonCode === 'MANUAL_CHECK' && project.stages[stage.id]?.status !== 'manual') ||
        !['MANUAL_CHECK', 'FINAL_MANUAL_CHECK'].includes(project.reasonCode ?? '')
      )
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Этот этап сейчас не ожидает ручной проверки.',
        );
      this.service.leases.acquire(project.id, project.workspace);
      try {
        const current = await this.service.coordinator.capture(project);
        if (
          current.digest !== request.expectedResultRevision ||
          project.resultSnapshot?.digest !== request.expectedResultRevision
        )
          throw new ApplicationError(
            'PROJECT_CHANGED',
            'Файлы изменились. Обновите проверку перед подтверждением.',
          );
        const state = project.stages[stage.id]!;
        project.reports.push({
          id: id(),
          phase: project.phase === 'acceptance' ? 'final' : 'stage',
          stageId: stage.id,
          attempt: state.attempt,
          at: new Date().toISOString(),
          status: request.outcome,
          workspaceRevision: current.digest,
          checks: [],
          note: request.comment || stage.verification.instructions,
        });
        if (request.outcome === 'failed') {
          state.status = 'blocked';
          project.reason = 'Ручная проверка не пройдена. Уточните этап и продолжите исправление.';
          project.reasonCode = 'MANUAL_FAILED';
          project.phase = 'stages';
          return this.service.coordinator.checkpoint(project);
        }
        state.manualRevision = current.digest;
        state.status = 'completed';
        project.checkpoint = current;
        project = await this.service.coordinator.save(
          project,
          'project.manual_verified',
          'Человек подтвердил проверку: ' + stage.title,
        );
        if (project.phase === 'acceptance') return this.service.coordinator.prepareReview(project);
        project.status = 'running';
        delete project.reason;
        delete project.reasonCode;
        project = await this.service.coordinator.save(
          project,
          'project.stage_verified',
          'Этап принят; продолжаем план.',
        );
        return this.service.coordinator.advance(project);
      } catch (error) {
        if (!project.intent?.runId || !this.service.runs.busy(project.intent.runId))
          this.service.leases.release(project.id);
        throw error;
      }
    });
  }
  /** Обновляет доказательства без изменения принятых критериев. */
  recheck(input: ProjectInput<'recheck'>) {
    return this.service.mutate('recheck', input, async (project) => {
      this.service.requireIdle(project);
      if (!project.plan || project.acceptedVersion !== project.plan.version)
        throw new ApplicationError('PROJECT_CONFLICT', 'Сначала примите план.');
      if (
        project.reasonCode !== 'MANUAL_CHECK' &&
        project.plan.stages.some((stage) => project.stages[stage.id]?.status !== 'completed')
      )
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Повторная итоговая проверка доступна после завершения всех этапов.',
        );
      if (['completed', 'cancelled', 'ready', 'draft'].includes(project.status))
        throw new ApplicationError(
          'PROJECT_CONFLICT',
          'Проект сейчас не ожидает повторной проверки.',
        );
      await this.service.requireKnownOperations(project);
      this.service.leases.acquire(project.id, project.workspace);
      try {
        if (project.reasonCode === 'MANUAL_CHECK') {
          project.resultSnapshot = await this.service.coordinator.capture(project);
          return await this.service.coordinator.checkpoint(project);
        }
        if (project.reasonCode === 'FINAL_MANUAL_CHECK')
          return await this.service.coordinator.prepareReview(project);
        delete project.intent;
        delete project.resultSnapshot;
        project.status = 'running';
        project.phase = 'final';
        project = await this.service.coordinator.save(
          project,
          'project.recheck',
          'Повторная проверка итогового состояния.',
        );
        return await this.service.coordinator.advance(project);
      } catch (error) {
        if (!project.runIds.some((runId) => this.service.runs.busy(runId)))
          this.service.leases.release(project.id);
        throw error;
      }
    });
  }
  /** Фиксирует приёмку и открывает доступ к доказательствам для обучения. */
  accept(input: ProjectInput<'accept'>) {
    return this.service.mutate('accept', input, async (project, request) => {
      this.service.requireIdle(project);
      if (
        project.status !== 'review' ||
        project.phase !== 'acceptance' ||
        !project.resultSnapshot ||
        project.plan!.stages.some((stage) => project.stages[stage.id]?.status !== 'completed')
      )
        throw new ApplicationError('PROJECT_CONFLICT', 'Результат ещё не готов к приёмке.');
      this.service.leases.acquire(project.id, project.workspace);
      try {
        await this.service.verifyAcceptance?.(project);
        const current = await this.service.coordinator.capture(project);
        if (
          project.resultSnapshot.digest !== request.expectedResultRevision ||
          current.digest !== request.expectedResultRevision
        )
          throw new ApplicationError(
            'PROJECT_CHANGED',
            'Файлы изменились после проверок. Запустите повторную проверку.',
          );
        project.status = 'completed';
        project.reason = 'Результат принят человеком.';
        delete project.reasonCode;
        project = await this.service.coordinator.save(project, 'project.accepted', project.reason);
        await this.service.coordinator.options.onAccepted(project);
        return project;
      } finally {
        this.service.leases.release(project.id);
      }
    });
  }
  /** Сохраняет проверенный человеком исход прерванной операции. */
  resolve(input: ProjectInput<'resolve'>) {
    return this.service.mutate('resolve', input, async (project, request) => {
      this.service.requireIdle(project);
      if (!project.runIds.includes(request.runId))
        throw new ApplicationError('PROJECT_CONFLICT', 'Операция принадлежит другому проекту.');
      const run = await this.service.runs.inspect(request.runId),
        invocation = run.invocations[request.invocationId];
      if (
        invocation?.status !== (request.succeeded ? 'succeeded' : 'error') ||
        invocation.result !== request.result
      )
        await this.service.runs.resolve({
          runId: request.runId,
          invocationId: request.invocationId,
          result: request.result,
          succeeded: request.succeeded,
        });
      return this.service.coordinator.save(
        project,
        'project.operation_resolved',
        'Человек проверил неизвестный результат операции.',
      );
    });
  }
  /** Изменяет видимость проекта без удаления истории. */
  archive(input: ProjectInput<'archive'>) {
    return this.service.mutate('archive', input, async (project, request) => {
      this.service.requireIdle(project);
      if (request.archived) project.archivedAt = new Date().toISOString();
      else delete project.archivedAt;
      return this.service.coordinator.save(
        project,
        'project.archive_changed',
        request.archived ? 'Проект убран в архив.' : 'Проект возвращён из архива.',
      );
    });
  }
}
