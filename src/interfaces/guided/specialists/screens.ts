import type { RunInsights } from '../../../insights/schema.js';
import { isMissingResource } from '../../../shared/resource-errors.js';
import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { supportsInsights } from './capability.js';
import {
  activityText,
  agentSummary,
  agentTree,
  completenessLabels,
  runSummary,
  specialistTabs,
  usageText,
} from './format.js';
import { relatedChecks, type ProjectScope } from './checks.js';

const missing = (error: unknown): boolean =>
  isMissingResource(error, 'task') || isMissingResource(error, 'project');

/** Карточка держит только одну страницу событий; выбранная вкладка и прокрутка сохраняются. */
export async function inspectSpecialist(
  context: CliContext,
  runId: string,
  agentId: string,
  project?: ProjectScope,
): Promise<void> {
  const cursors = [0];
  const resultCursors = [0];
  let selectedAgent: RunInsights['agents'][number] | undefined;
  let activity: CommandResponse<'runtime.activity'> | undefined;
  const load = async () => {
    const [insights, page] = await Promise.all([
      context.request('runtime.insights', { runId, agentId, resultCursor: resultCursors.at(-1)! }),
      context.request('runtime.activity', { runId, agentId, cursor: cursors.at(-1)!, limit: 100 }),
    ]);
    activity = page;
    selectedAgent = insights.agents.find((agent) => agent.id === agentId);
    return {
      tabs: specialistTabs(
        insights,
        agentId,
        [
          completenessLabels[page.completeness],
          `Страница ${cursors.length}${page.hasMore ? ' · есть продолжение' : ''}`,
          activityText(page.events),
        ].join('\n\n'),
      ),
      subtitle: insights.agents.find((agent) => agent.id === agentId)?.role ?? agentId,
      actionLabel: 'страницы и проверки',
    };
  };
  while (true) {
    const snapshot = await load();
    if (
      (await readText('Работа специалиста', snapshot.tabs, {
        ...snapshot,
        load,
        exitOnError: missing,
      })) === 'back'
    )
      return;
    const choice = await liveSelect({
      title: 'Журнал специалиста',
      exitOnError: missing,
      load: async () => {
        await load();
        return {
          message: 'Что открыть?',
          options: [
            ...(activity?.hasMore
              ? [{ value: 'next', label: 'Следующая страница журнала →' }]
              : []),
            ...(cursors.length > 1
              ? [{ value: 'previous', label: '← Предыдущая страница журнала' }]
              : []),
            ...(selectedAgent?.resultTruncated
              ? [{ value: 'result-next', label: 'Следующая часть результата →' }]
              : []),
            ...(resultCursors.length > 1
              ? [{ value: 'result-previous', label: '← Предыдущая часть результата' }]
              : []),
            ...(project ? [{ value: 'checks', label: 'Связанные проверки' }] : []),
            { value: 'read', label: '← Читать карточку' },
            { value: 'back', label: '← К специалистам' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'next' && activity?.hasMore) cursors.push(activity.cursor);
    if (choice === 'previous' && cursors.length > 1) cursors.pop();
    if (choice === 'result-next' && selectedAgent?.resultTruncated)
      resultCursors.push((selectedAgent.resultCursor ?? 0) + (selectedAgent.result?.length ?? 0));
    if (choice === 'result-previous' && resultCursors.length > 1) resultCursors.pop();
    if (choice === 'checks' && project) await relatedChecks(context, runId, project);
  }
}

/** Список выбирает агента по ID; появление новой ветки не переносит выделение на соседа. */
export async function browseSpecialists(
  context: CliContext,
  runId: string,
  project?: ProjectScope,
): Promise<void> {
  if (!(await supportsInsights(context))) return;
  const pageSize = 50;
  const selections = new Map<number, string>();
  let offset = 0;
  let hasMore = false;
  const load = () =>
    context.request('runtime.insights', { runId, agentOffset: offset, agentLimit: pageSize });
  while (true) {
    const choice = await liveSelect({
      title: 'Работа специалистов',
      initialValue: selections.get(offset),
      exitOnError: missing,
      load: async () => {
        const insights = await load();
        const total = insights.agentTotal ?? insights.agents.length;
        hasMore = offset + insights.agents.length < total;
        return {
          summary: runSummary(insights),
          summaryRows: 6,
          message: `Специалисты · ${Math.floor(offset / pageSize) + 1}/${Math.max(1, Math.ceil(total / pageSize))}`,
          options: [
            ...agentTree(insights.agents).map(({ agent, depth }) => ({
              value: 'agent:' + agent.id,
              label: (depth ? '  '.repeat(Math.min(depth - 1, 8)) + '↳ ' : '') + agent.role,
              hint: agentSummary(agent, insights.completeness !== 'unavailable'),
            })),
            ...(hasMore ? [{ value: 'next', label: 'Следующие специалисты →' }] : []),
            ...(offset ? [{ value: 'previous', label: '← Предыдущие специалисты' }] : []),
            { value: 'totals', label: 'Время и токены всей задачи' },
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'next' || choice === 'previous') {
      if (choice === 'next' && hasMore) offset += pageSize;
      if (choice === 'previous') offset = Math.max(0, offset - pageSize);
      continue;
    }
    selections.set(offset, choice);
    if (choice === 'totals') {
      const totals = (insights: RunInsights) => ({
        tabs: [
          {
            id: 'totals',
            label: 'Итоги',
            text: [
              runSummary(insights),
              usageText(insights.usage),
              `Повторов запросов: ${insights.retries}`,
              ...(insights.completeness !== 'complete'
                ? [
                    `Старый общий учёт задачи: ${insights.legacyUsage.input} вход / ${insights.legacyUsage.output} выход. Распределение по специалистам неизвестно.`,
                  ]
                : []),
              'Время параллельных специалистов пересекается. Сумма отдельных интервалов не равна времени задачи.',
            ].join('\n\n'),
          },
        ],
      });
      await readText('Итоги работы', totals(await load()).tabs, {
        load: async () => totals(await load()),
        exitOnError: missing,
      });
    }
    if (choice.startsWith('agent:')) {
      const agentId = choice.slice(6);
      if (
        (await context.request('runtime.insights', { runId, agentId })).agents.some(
          (agent) => agent.id === agentId,
        )
      )
        await inspectSpecialist(context, runId, agentId, project);
    }
  }
}
