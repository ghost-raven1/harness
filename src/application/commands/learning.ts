import { z } from 'zod';
import type { Application } from '../bootstrap.js';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { saveLesson } from '../../learning/export.js';
import { ResourceNotFoundError } from '../../shared/resource-errors.js';

/** Выполняет команды группы learning через сервисы приложения. */
export async function learningCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  if (!['learning.status', 'learning.inspect'].includes(method)) app.sessions.assertWritable();
  switch (method) {
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
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
