import type { JournalEvent } from '../sessions/types.js';
import type { StatusView } from './types.js';
import { toolSummary } from './tool-summary.js';

/** Проекция журнала исключает снимки конфигурации, подписи reasoning и большие результаты. */
export function taskEvent(event: JournalEvent): StatusView['events'][number] {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const invocation = event.state.invocations[String(payload.invocationId)];
  const approval = Object.values(event.state.approvals).find(
    (item) => item.id === payload.approvalId,
  );
  const agent =
    event.state.agents[String(payload.agentId ?? approval?.agentId ?? payload.parentId)];
  let detail: string | undefined;
  let title: string | undefined;
  if (invocation) {
    ({ title, detail } = toolSummary(invocation));
  } else if (approval) detail = approval.tool;
  else if (event.type === 'run.failed') detail = event.state.error;
  const model =
    event.type === 'model.completed' && !payload.requestId ? agent?.messages.at(-1) : undefined;
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    payload: event.payload,
    role: agent?.role,
    title,
    detail: detail?.slice(0, 1000),
    ...(model?.role === 'assistant'
      ? {
          preview: {
            text: model.content.slice(0, 65536),
            reasoning: model.reasoning?.slice(0, 65536),
          },
        }
      : {}),
  };
}
