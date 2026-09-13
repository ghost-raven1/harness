import { z } from 'zod';
import { FileChanges } from '../tools/file-changes.js';
import { fileCommand } from './file-routes.js';
import { draftCommand } from './draft-routes.js';
import { queryHistory } from '../sessions/history.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Application } from './application.js';
import { runInputSchema } from '../runtime/engine.js';
import { taskEvent } from './task-events.js';
import { saveLesson } from './guided/knowledge-format.js';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { observeCommand } from '../diagnostics/observe-command.js';
import { dataResetScopeSchema } from '../application/data-reset-records.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import { resultCursorSchema, resultFields, taskPreview, textPage } from './result-pages.js';
const runIdSchema = z.object({ runId: z.string().uuid() }).strict();
export const statusInputSchema = z
  .object({
    runId: z.string().uuid(),
    cursor: z.number().int().min(0).default(0),
    waitMs: z.number().int().min(0).max(25000).default(0),
    resultCursor: resultCursorSchema.optional(),
  })
  .strict();

export async function runStatus(
  app: Application,
  runId: string,
  cursor = 0,
  resultCursor?: number,
): Promise<Record<string, unknown>> {
  const run = app.sessions.get(runId);
  const events = app.sessions.history(runId, cursor, 100);
  return {
    runId,
    task: run.agents[run.rootAgentId]?.task,
    createdAt: run.createdAt,
    deletedAt: run.deletedAt,
    sessionId: run.sessionId,
    status: run.status,
    ...resultFields(run.result, resultCursor),
    error: run.error,
    pauseReason: run.pauseReason,
    providerPause: run.providerPause,
    workspace: run.workspace,
    profile: run.profile,
    turns: run.turns,
    iterations: app.runtime.runIterationStatus(runId),
    usage: run.usage,
    budget: await app.runtime.usage.status(runId),
    learningVersion: run.learningVersion,
    artifacts: run.artifacts ?? [],
    fileChanges: (run.fileChanges ?? []).map(({ canonical: _canonical, ...change }) => change),
    agents: Object.values(run.agents).map((agent) => ({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      parentId: agent.parentId,
    })),
    approvals: ['running', 'awaiting_approval', 'paused'].includes(run.status)
      ? Object.values(run.approvals).filter((item) => item.status === 'pending')
      : [],
    unknownInvocations: Object.values(run.invocations)
      .filter((item) => item.status === 'unknown')
      .map((item) => ({
        id: item.id,
        tool: item.call.name,
        arguments: item.call.arguments,
        result: item.result,
      })),
    cursor: events.at(-1)?.seq ?? cursor,
    events: events.map(({ seq, at, type, payload }) => ({ seq, at, type, payload })),
    hasMoreEvents: app.sessions.history(runId, events.at(-1)?.seq ?? cursor, 1).length > 0,
  };
}
/** Локальные команды управления; MCP экспортирует только три разрешённых операции. */
export async function dispatch(app: Application, method: string, input: unknown): Promise<unknown> {
  const execute = () => dispatchCommand(app, method, input);
  return app.diagnostics ? observeCommand(app.diagnostics, method, execute) : execute();
}

async function dispatchCommand(app: Application, method: string, input: unknown): Promise<unknown> {
  if (method.startsWith('files.')) return fileCommand(app, method, input);
  if (method.startsWith('drafts.')) return draftCommand(app, method, input);
  switch (method) {
    case 'iterations.status': {
      const { runId } = z
        .object({ runId: z.string().uuid().optional() })
        .strict()
        .parse(input ?? {});
      return app.runtime.iterationStatus(runId);
    }
    case 'iterations.configure': {
      const args = z
        .object({
          limit: z.number().int().positive().safe(),
          runId: z.string().uuid().optional(),
          expectedLimit: z.number().int().positive().safe().optional(),
        })
        .strict()
        .parse(input);
      await app.runtime.setIterationLimit(args.limit, args.runId, args.expectedLimit);
      return app.runtime.iterationStatus(args.runId);
    }
    case 'diagnostics.status':
      return app.diagnostics.status();
    case 'diagnostics.configure': {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(input);
      return app.diagnostics.setEnabled(enabled);
    }
    case 'maintenance.resetPreview': {
      const { scope } = z.object({ scope: dataResetScopeSchema }).strict().parse(input);
      return app.reset.preview(scope);
    }
    case 'maintenance.reset': {
      const { scope, previewToken } = z
        .object({
          scope: dataResetScopeSchema,
          previewToken: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(input);
      return app.reset.reset(scope, previewToken);
    }
    case 'runtime.purgePreview':
      return app.purge.preview(runIdSchema.parse(input).runId);
    case 'runtime.purge': {
      const args = runIdSchema
        .extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
        .parse(input);
      return app.purge.purge(args.runId, args.previewToken);
    }
    case 'runtime.delete': {
      const args = runIdSchema.parse(input);
      await app.sessions.delete(args.runId);
      return { deleted: true };
    }
    case 'runtime.task': {
      const args = statusInputSchema
        .extend({ outputCursor: z.number().int().min(0).default(0) })
        .parse(input);
      const status = await runStatus(app, args.runId, args.cursor, args.resultCursor);
      return {
        ...status,
        events: app.sessions.history(args.runId, args.cursor, 100).map(taskEvent),
        output: await app.sessions.output.page(args.runId, args.outputCursor),
      };
    }
    case 'runtime.run':
      return app.runtime.start(runInputSchema.parse(input));
    case 'runtime.result': {
      const args = runIdSchema.extend({ cursor: resultCursorSchema.default(0) }).parse(input);
      return textPage(app.sessions.get(args.runId).result ?? '', args.cursor);
    }
    case 'runtime.status': {
      const args = statusInputSchema.parse(input);
      const until = Date.now() + args.waitMs;
      while (
        !app.sessions.history(args.runId, args.cursor, 1).length &&
        ['running', 'awaiting_approval'].includes(app.sessions.get(args.runId).status) &&
        Date.now() < until
      )
        await delay(100);
      return runStatus(app, args.runId, args.cursor, args.resultCursor);
    }
    case 'runtime.list': {
      const args = z
        .object({
          offset: z.number().int().nonnegative().safe().default(0),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict()
        .parse(input ?? {});
      return app.sessions
        .list()
        .reverse()
        .slice(args.offset, args.limit === undefined ? undefined : args.offset + args.limit)
        .map((run) => ({
          runId: run.id,
          status: run.status,
          task: run.agents[run.rootAgentId]!.task,
          profile: run.profile,
          createdAt: run.createdAt,
        }))
        .map(taskPreview);
    }
    case 'runtime.history': {
      const args = z
        .object({
          query: z.string().max(200).default(''),
          page: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(10),
          includeDeleted: z.boolean().default(false),
        })
        .strict()
        .parse(input ?? {});
      const page = queryHistory(
        app.sessions.list(args.includeDeleted),
        args.query,
        args.page,
        args.limit,
      );
      return { ...page, active: page.active.map(taskPreview), items: page.items.map(taskPreview) };
    }
    case 'budget.status':
      return app.runtime.usage.status(
        z
          .object({ runId: z.string().uuid().optional() })
          .strict()
          .parse(input ?? {}).runId,
      );
    case 'runtime.cancel':
      await app.runtime.cancel(runIdSchema.parse(input).runId);
      return { cancelled: true };
    case 'runtime.resume':
      await app.runtime.resume(runIdSchema.parse(input).runId);
      return { resumed: true };
    case 'runtime.resolve': {
      const args = z
        .object({
          runId: z.string().uuid(),
          invocationId: z.string(),
          result: z.string().max(1000000),
          succeeded: z.boolean(),
        })
        .strict()
        .parse(input);
      await app.runtime.resolveInvocation(
        args.runId,
        args.invocationId,
        args.result,
        args.succeeded,
      );
      return { resolved: true };
    }
    case 'approvals.list':
      return app.approvals.pending();
    case 'approvals.decide': {
      const args = z
        .object({
          approvalId: z.string().uuid(),
          allow: z.boolean(),
          previewToken: z.string().length(64).optional(),
        })
        .strict()
        .parse(input);
      const approval = app.approvals.pending().find((item) => item.id === args.approvalId);
      if (args.allow && approval?.tool === 'fs.write') {
        const preview = await new FileChanges(app.sessions).previewApproval(args.approvalId);
        if (preview.previewToken !== args.previewToken)
          throw new Error('Перед разрешением записи нужен актуальный предпросмотр файла.');
      }
      await app.approvals.resolve(args.approvalId, args.allow, args.previewToken);
      return { decided: true };
    }
    case 'learning.status': {
      const state = app.learning.store.read();
      return {
        activeVersion: state.activeVersion,
        activeCandidateIds: state.releases[state.activeVersion]?.candidateIds ?? [],
        releases: Object.values(state.releases),
        enabled: app.config.value.learning.enabled,
        dailyLimit: null,
        controlCases: app.config.value.learning.cases.length,
        evaluationReady:
          app.config.value.learning.cases.some((item) => item.kind === 'target') &&
          app.config.value.learning.cases.some((item) => item.kind === 'holdout'),
        paused: state.paused,
        daily: state.daily,
        jobs: state.jobs,
        candidates: Object.values(state.candidates).map(
          ({ id, title, status, reason, workspace, role, profile }) => ({
            id,
            title,
            status,
            reason,
            workspace,
            role,
            profile,
          }),
        ),
      };
    }
    case 'learning.inspect': {
      const args = z.object({ id: z.string() }).strict().parse(input);
      const state = app.learning.store.read(),
        candidate = state.candidates[args.id];
      if (!candidate) throw new ResourceNotFoundError('lesson');
      return {
        candidate,
        evidence: candidate.evidenceIds.map((id) => state.evidence[id]),
        report: state.reports[args.id],
      };
    }
    case 'learning.export': {
      const args = z.object({ id: z.string().uuid() }).strict().parse(input);
      return app.scheduler.schedule('write', async () => {
        app.sessions.assertWritable();
        const state = app.learning.store.read(),
          candidate = state.candidates[args.id];
        if (!candidate) throw new ResourceNotFoundError('lesson');
        try {
          const path = await saveLesson(
            app.directory,
            {
              candidate,
              evidence: candidate.evidenceIds.map((id) => state.evidence[id]),
              report: state.reports[args.id],
            },
            state.releases[state.activeVersion]!.candidateIds.includes(args.id),
          );
          return { path };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const path = join(app.directory, 'exports', 'Урок Harness ' + args.id + '.md');
          // EEXIST может относиться к каталогу exports, а не к уже сохранённому уроку.
          const existing = await lstat(path).catch(() => undefined);
          if (!existing?.isFile())
            throw new Error(
              'Экспорт не записан. Проверьте, что exports — обычная папка, а путь урока не занят папкой или ссылкой.',
              { cause: error },
            );
          return { path, exists: true };
        }
      });
    }
    case 'learning.feedback': {
      const args = z
        .object({
          runId: z.string().uuid(),
          positive: z.boolean(),
          text: z.string().min(1),
          candidateId: z.string().optional(),
        })
        .strict()
        .parse(input);
      await app.learning.feedback(args.runId, args.positive, args.text, args.candidateId);
      return { recorded: true };
    }
    case 'learning.rollback': {
      const args = z
        .object({ reason: z.string().min(1) })
        .strict()
        .parse(input);
      await app.learning.rollback(args.reason);
      return { rolledBack: true };
    }
    case 'learning.pause':
      await app.learning.pause(true);
      return { paused: true };
    case 'learning.resume':
      await app.learning.pause(false);
      return { paused: false };
    case 'system.info':
      return {
        configFile: app.configFile,
        version: '0.1.0',
        node: process.version,
        state: app.directory,
        activeRuns: app.sessions
          .list()
          .filter((run) => ['running', 'awaiting_approval'].includes(run.status)).length,
        pendingApprovals: app.approvals.pending().length,
        learningVersion: app.learning.store.read().activeVersion,
        knowledgeCount: Object.keys(app.learning.store.read().candidates).length,
        workspaces: app.config.value.workspaces,
        defaultProfile: app.config.value.defaultProfile,
        profiles: Object.entries(app.config.value.profiles).map(([id, profile]) => ({
          id,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          configured: !profile.apiKeyEnv || !!process.env[profile.apiKeyEnv],
        })),
        tools: app.registry.definitions().map((tool) => tool.name),
      };
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
