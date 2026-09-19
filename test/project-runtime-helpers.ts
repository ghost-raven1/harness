import type { ProjectRunStart } from '../src/sessions/project-run.js';
import type { harness } from './helpers.js';

/** Закрепляет настройки тестового проекта отдельно от будущих пользовательских запусков. */
export function projectInput(
  app: Awaited<ReturnType<typeof harness>>,
  kind: 'planning' | 'stage' | 'checks' = 'stage',
): ProjectRunStart {
  return {
    link: { projectId: 'project-a', planVersion: 1, attempt: 0, kind },
    requestKey: 'project-' + kind,
    workspace: app.workspace,
    profile: 'test',
    config: structuredClone(app.snapshot),
    learningVersion: 'baseline',
    role: 'worker',
    message: 'Выполни этап проекта.',
  };
}
