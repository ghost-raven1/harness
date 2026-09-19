import type { Application } from '../bootstrap.js';
import { applicationIdentity } from '../../shared/identity.js';

/** Выполняет команды группы system через сервисы приложения. */
export async function systemCommand(
  app: Application,
  method: string,
  _input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'system.info': {
      const runs = app.sessions.catalog();
      const projects = app.projects?.catalog(true, runs) ?? [];
      const visibleProjects = projects.filter((project) => !project.archivedAt);
      const learning = app.learning.store.read();
      return {
        configFile: app.configFile,
        ...applicationIdentity(),
        node: process.version,
        state: app.directory,
        activeRuns: runs.filter((run) =>
          ['running', 'awaiting_approval'].includes(app.runtime.visibleStatus(run.id, run.status)),
        ).length,
        activeProjects: projects.filter((project) =>
          ['running', 'planning', 'pausing'].includes(project.status),
        ).length,
        projectCount: visibleProjects.length,
        projectsAwaitingDecision: visibleProjects.filter((project) => project.attention).length,
        pendingApprovals: app.sessions.recoveryError ? 0 : app.approvals.pending(runs).length,
        recoveryError: app.sessions.recoveryError ?? app.projects?.store.recoveryError,
        learningVersion: learning.activeVersion,
        knowledgeCount: Object.keys(learning.candidates).length,
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
    }
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
