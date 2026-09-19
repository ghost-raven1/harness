import type { ProjectView } from '../src/projects/types.js';

/** Минимальная карточка для проверок контрактов и локальных экранов. */
export function projectFixture(overrides: Partial<ProjectView> = {}): ProjectView {
  return {
    projectId: 'fa3a6797-0448-497b-bb5c-2ed33e8990fa',
    title: 'Проверить приложение',
    goal: 'Добавить понятную страницу ошибок.',
    workspace: '/workspace',
    profile: 'test',
    revision: 3,
    status: 'ready',
    createdAt: '2026-09-19T00:00:00Z',
    updatedAt: '2026-09-19T00:00:00Z',
    progress: { total: 1, completed: 0, running: 0, blocked: 0 },
    allowedActions: ['plan', 'editPlan', 'acceptPlan', 'archive', 'purge'],
    roles: [{ id: 'developer', label: 'Разработчик' }],
    plan: {
      version: 2,
      maxCorrections: 2,
      fixBaselineFailures: false,
      stages: [
        {
          id: 'implement',
          title: 'Страница ошибок',
          task: 'Добавить страницу ошибок',
          role: 'developer',
          dependsOn: [],
          expectedResult: 'Понятная ошибка',
          requiredTools: ['fs.write'],
          verification: {
            kind: 'commands',
            checks: [
              {
                id: 'test',
                title: 'Тесты',
                command: 'npm',
                args: ['test', '--', 'file with space'],
              },
            ],
          },
        },
      ],
    },
    planVersion: 2,
    stages: [{ stageId: 'implement', title: 'Страница ошибок', status: 'pending', attempt: 0 }],
    reports: [],
    changes: [],
    changesTruncated: false,
    blockers: [],
    events: { items: [], cursor: 0, hasMore: false },
    ...overrides,
  };
}
