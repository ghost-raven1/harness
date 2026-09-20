import type { CliContext } from '../../types.js';

/** Старые сервисы продолжают работать без обращения к новым командам. */
export async function supportsInsights(context: CliContext): Promise<boolean> {
  const info = await context.request('system.info');
  return info?.capabilities?.includes('execution-insights-v1') ?? false;
}
