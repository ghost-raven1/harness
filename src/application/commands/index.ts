import { ApplicationError } from '../../shared/application-error.js';
import type { Application } from '../bootstrap.js';
import { observeCommand } from '../../diagnostics/observe-command.js';
import { fileCommand } from '../file-routes.js';
import { draftCommand } from '../draft-routes.js';
import { tasksCommand } from './tasks.js';
import { historyCommand } from './history.js';
import { approvalsCommand } from './approvals.js';
import { learningCommand } from './learning.js';
import { diagnosticsCommand } from './diagnostics.js';
import { systemCommand } from './system.js';
import { projectsCommand } from './projects.js';

/** В режиме диагностики команды не меняют задачи, разрешения, черновики и настройки исполнения. */
const readOnlyCommands = new Set([
  'projects.list',
  'projects.detail',
  'projects.purgePreview',
  'system.info',
  'runtime.list',
  'runtime.history',
  'runtime.status',
  'runtime.task',
  'runtime.result',
  'runtime.purgePreview',
  'maintenance.resetPreview',
  'budget.status',
  'iterations.status',
  'approvals.list',
  'learning.status',
  'learning.inspect',
  'drafts.list',
  'drafts.get',
  'files.preview',
  'files.previewRestore',
  'files.previewResolution',
  'diagnostics.status',
  'diagnostics.configure',
  'diagnostics.verifyHistory',
  'diagnostics.rebuildIndex',
]);

export { runStatus, statusInputSchema } from './task-status.js';

/** Выбирает прикладной обработчик; внешний транспорт отвечает за кодирование сообщений. */
export async function dispatch(app: Application, method: string, input: unknown): Promise<unknown> {
  const execute = () => {
    const recoveryError = app.sessions?.recoveryError ?? app.projects?.store.recoveryError;
    if (recoveryError && !readOnlyCommands.has(method))
      throw new ApplicationError('STORAGE_UNAVAILABLE', recoveryError);
    return dispatchCommand(app, method, input);
  };
  return app.diagnostics ? observeCommand(app.diagnostics, method, execute) : execute();
}

/** Маршрутизация не содержит файловых операций и логики жизненного цикла задачи. */
function dispatchCommand(app: Application, method: string, input: unknown): Promise<unknown> {
  if (method.startsWith('projects.')) return projectsCommand(app, method, input);
  if (method.startsWith('files.')) return fileCommand(app, method, input);
  if (method.startsWith('drafts.')) return draftCommand(app, method, input);
  if (
    [
      'iterations.status',
      'iterations.configure',
      'runtime.task',
      'runtime.run',
      'runtime.message',
      'runtime.result',
      'runtime.status',
      'budget.status',
      'runtime.cancel',
      'runtime.resume',
      'runtime.resolve',
    ].includes(method)
  )
    return tasksCommand(app, method, input);
  if (
    [
      'runtime.list',
      'runtime.history',
      'runtime.purgePreview',
      'runtime.purge',
      'runtime.delete',
      'maintenance.resetPreview',
      'maintenance.reset',
    ].includes(method)
  )
    return historyCommand(app, method, input);
  if (['approvals.list', 'approvals.decide'].includes(method))
    return approvalsCommand(app, method, input);
  if (
    [
      'learning.status',
      'learning.inspect',
      'learning.export',
      'learning.feedback',
      'learning.rollback',
      'learning.pause',
      'learning.resume',
    ].includes(method)
  )
    return learningCommand(app, method, input);
  if (
    [
      'diagnostics.status',
      'diagnostics.configure',
      'diagnostics.verifyHistory',
      'diagnostics.rebuildIndex',
    ].includes(method)
  )
    return diagnosticsCommand(app, method, input);
  if (['system.info'].includes(method)) return systemCommand(app, method, input);
  return Promise.reject(new ApplicationError('UNKNOWN_COMMAND', 'Unknown local method: ' + method));
}
