import { FileLearningStore } from '../../learning/store.js';
import { z } from 'zod';
import type { Application } from '../bootstrap.js';

/** Выполняет команды группы diagnostics через сервисы приложения. */
export async function diagnosticsCommand(
  app: Application,
  method: string,
  input: unknown,
): Promise<unknown> {
  switch (method) {
    case 'diagnostics.verifyHistory':
      return app.sessions.verifyHistory((work) =>
        app.nest.get(FileLearningStore).withReadBarrier(work),
      );
    case 'diagnostics.rebuildIndex':
      return app.sessions.rebuildIndex();
    case 'diagnostics.status':
      return app.diagnostics.status();
    case 'diagnostics.configure': {
      const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(input);
      return app.diagnostics.setEnabled(enabled);
    }
    default:
      throw new Error('Unknown local method: ' + method);
  }
}
