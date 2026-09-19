import type { Application } from '../bootstrap.js';
import { applicationIdentity } from '../../shared/identity.js';

/** Выполняет команды группы system через сервисы приложения. */
export async function systemCommand(
  app: Application,
  method: string,
  _input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'system.info':
      return {
        configFile: app.configFile,
        ...applicationIdentity(),
        node: process.version,
        state: app.directory,
        activeRuns: app.sessions
          .catalog()
          .filter((run) =>
            ['running', 'awaiting_approval'].includes(
              app.runtime.visibleStatus(run.id, run.status),
            ),
          ).length,
        activeProjects:
          app.projects?.store
            .catalog(true)
            .filter((project) => ['running', 'planning', 'pausing'].includes(project.status))
            .length ?? 0,
        projectCount: app.projects?.store.catalog().length ?? 0,
        pendingApprovals: app.sessions.recoveryError ? 0 : app.approvals.pending().length,
        recoveryError: app.sessions.recoveryError ?? app.projects?.store.recoveryError,
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
