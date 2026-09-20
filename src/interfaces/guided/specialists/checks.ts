import type { CliContext } from '../../types.js';
import { liveSelect } from '../live-select.js';
import { browseProjectReports, phaseLabels } from '../project-work/reports.js';
import { isMissingResource } from '../../../shared/resource-errors.js';

export interface ProjectScope {
  projectId: string;
  stageId?: string;
  attempt?: number;
}

/** Проверки другой попытки не выдаются за доказательства выбранной работы. */
export async function relatedChecks(
  context: CliContext,
  runId: string,
  project: ProjectScope,
): Promise<void> {
  let offset = 0;
  while (true) {
    const choice = await liveSelect({
      title: 'Связанные проверки',
      exitOnError: (error) => isMissingResource(error, 'project'),
      load: async () => {
        const page = await context.request('projects.reports', { ...project, offset });
        const reports = page.items.filter(
          (report) =>
            report.runId === runId ||
            (project.stageId !== undefined &&
              report.stageId === project.stageId &&
              report.attempt === project.attempt),
        );
        return {
          summary: reports.length
            ? 'Доказательства выбранного запуска или попытки этапа.'
            : 'На этой странице связанных проверок нет.',
          message: 'Выберите сохранённую проверку',
          options: [
            ...reports.map((report) => ({
              value: 'report:' + report.id,
              label: `${phaseLabels[report.phase]} · попытка ${report.attempt}`,
              hint: report.current ? 'актуальные доказательства' : 'история',
            })),
            ...(page.nextOffset === undefined
              ? []
              : [{ value: 'next', label: 'Следующая страница →' }]),
            ...(offset ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
            { value: 'back', label: '← К специалисту' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'next') offset += 20;
    if (choice === 'previous') offset = Math.max(0, offset - 20);
    if (choice.startsWith('report:'))
      await browseProjectReports(context, project.projectId, choice.slice(7));
  }
}
