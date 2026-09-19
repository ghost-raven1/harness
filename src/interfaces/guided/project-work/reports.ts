import type { EvidenceCheck, EvidenceReport } from '../../../projects/read-schema.js';
import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { followRun } from '../watch.js';
import { checkCommand } from './format.js';
import { projectChoice, projectField } from './form-input.js';
import type { WorkIndicator } from '../work-indicator.js';

export const checkLabels: Record<EvidenceCheck['state'], string> = {
  not_run: 'Не запускалась',
  running: 'Выполняется',
  completed: 'Завершилась',
  denied: 'Запрещена',
  cancelled: 'Отменена',
  unknown: 'Исход неизвестен',
  unavailable: 'Доказательство недоступно',
};
export const phaseLabels = {
  baseline: 'До изменений',
  stage: 'Проверка этапа',
  final: 'Итоговая проверка',
};
type OutputPage = CommandResponse<'projects.checkOutput'>;

/** Обрезание исполнителем отличается от перехода к следующей сохранённой странице. */
export function outputPageText(page: OutputPage): string {
  return [
    `${checkLabels[page.state]} · ${page.stream}`,
    page.evidence === 'pending'
      ? 'Команда ещё выполняется. Вывод станет доступен после её завершения.'
      : '',
    page.reason ?? '',
    page.truncated
      ? 'Внимание: исполнитель обрезал этот поток по пределу 1 048 576 символов. Ниже доступен весь сохранённый фрагмент.'
      : '',
    page.evidence === 'available'
      ? `Символы ${page.totalCharacters ? page.offset + 1 : 0}–${page.offset + page.text.length} из ${page.totalCharacters}${page.nextOffset === undefined ? ' · последняя страница' : ' · продолжение через Enter'}`
      : '',
    page.text || (page.evidence === 'available' ? 'Поток пуст.' : 'Сохранённый вывод недоступен.'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Клиент держит по одной странице каждого потока; большие JSON-артефакты остаются на сервере. */
export async function inspectProjectCheck(
  context: CliContext,
  projectId: string,
  report: EvidenceReport,
  check: EvidenceCheck,
): Promise<void> {
  const offsets = { stdout: [0], stderr: [0] };
  let pages!: { stdout: OutputPage; stderr: OutputPage };
  const load = async () => {
    const results = await Promise.all(
      (['stdout', 'stderr'] as const).map((stream) =>
        context.request('projects.checkOutput', {
          projectId,
          reportId: report.id,
          checkId: check.id,
          stream,
          offset: offsets[stream].at(-1)!,
        }),
      ),
    );
    const stdout = results[0]!,
      stderr = results[1]!;
    pages = { stdout, stderr };
    return {
      activity:
        stdout.state === 'running'
          ? ({ kind: 'busy', label: 'Выполняю проверочную команду' } satisfies WorkIndicator)
          : undefined,
      tabs: [
        {
          id: 'command',
          label: 'Команда',
          text: [
            check.title,
            phaseLabels[report.phase],
            `Попытка ${report.attempt}${report.current ? '' : ' · прежняя версия/попытка'}`,
            checkCommand(check.command, check.args),
            '\nБуквальные аргументы:',
            ...check.args.map((arg, index) => `${index + 1}: ${JSON.stringify(arg)}`),
            `Состояние: ${checkLabels[stdout.state]}`,
            `Код завершения: ${stdout.exitCode === undefined ? 'ещё не получен' : stdout.exitCode === null ? 'процесс прерван' : stdout.exitCode}`,
            stdout.reason ?? '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        { id: 'stdout', label: 'stdout', text: outputPageText(stdout) },
        { id: 'stderr', label: 'stderr', text: outputPageText(stderr) },
      ],
      actionLabel: 'страницы и журнал',
    };
  };
  while (true) {
    const snapshot = await load();
    if (
      (await readText(check.title, snapshot.tabs, {
        actionLabel: snapshot.actionLabel,
        activity: snapshot.activity,
        load,
      })) === 'back'
    )
      return;
    const choice = await liveSelect({
      title: 'Вывод проверки',
      load: async () => ({
        message: 'Страницы сохранённого вывода',
        options: [
          ...(['stdout', 'stderr'] as const).flatMap((stream) => [
            ...(pages[stream].nextOffset === undefined
              ? []
              : [{ value: `next:${stream}`, label: `Следующая страница ${stream}` }]),
            ...(offsets[stream].length > 1
              ? [{ value: `previous:${stream}`, label: `Предыдущая страница ${stream}` }]
              : []),
          ]),
          ...(report.runId ? [{ value: 'run', label: 'Открыть связанный запуск' }] : []),
          { value: 'read', label: '← Читать вывод' },
          { value: 'back', label: '← К проверкам' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'run' && report.runId)
      await followRun(context, report.runId, { inspect: true, projectManaged: true });
    const [direction, name] = choice.split(':');
    if (name === 'stdout' || name === 'stderr') {
      if (direction === 'next' && pages[name].nextOffset !== undefined)
        offsets[name].push(pages[name].nextOffset!);
      if (direction === 'previous' && offsets[name].length > 1) offsets[name].pop();
    }
  }
}

/** Фильтры читают страницы проверок, не загружая переписки связанных запусков. */
export async function browseProjectReports(
  context: CliContext,
  projectId: string,
  focusReportId?: string,
): Promise<void> {
  let offset = 0,
    phase: 'baseline' | 'stage' | 'final' | undefined,
    stageId: string | undefined,
    attempt: number | undefined;
  let focused: string | undefined;
  if (focusReportId) {
    let cursor = 0;
    while (true) {
      const page = await context.request('projects.reports', { projectId, offset: cursor });
      const report = page.items.find((report) => report.id === focusReportId);
      if (report) {
        offset = cursor;
        focused = report.id + '/' + (report.checks[0]?.id ?? 'manual');
        break;
      }
      if (page.nextOffset === undefined) break;
      cursor = page.nextOffset;
    }
  }
  while (true) {
    let reports: EvidenceReport[] = [];
    const choice = await liveSelect({
      title: 'Проверки и доказательства',
      initialValue: focused,
      load: async () => {
        const page = await context.request('projects.reports', {
          projectId,
          offset,
          phase,
          stageId,
          attempt,
        });
        reports = page.items;
        return {
          summary: `Проверок/попыток: ${page.total}\n${phase ? phaseLabels[phase] : 'Все фазы'}${stageId ? ' · выбран этап' : ''}${attempt === undefined ? '' : ` · попытка ${attempt}`}`,
          message: 'Выберите проверку',
          options: [
            ...page.items.flatMap((report) =>
              report.checks.length
                ? report.checks.map((check) => ({
                    value: `${report.id}/${check.id}`,
                    label: check.title,
                    hint: `${phaseLabels[report.phase]} · попытка ${report.attempt} · ${checkLabels[check.state]}${report.current ? '' : ' · история'}`,
                  }))
                : [
                    {
                      value: `${report.id}/manual`,
                      label: report.note || 'Ручная проверка',
                      hint: `${phaseLabels[report.phase]} · попытка ${report.attempt}`,
                    },
                  ],
            ),
            { value: 'phase', label: 'Фильтр по фазе' },
            { value: 'stage', label: 'Фильтр по этапу' },
            { value: 'attempt', label: 'Фильтр по попытке' },
            ...(phase || stageId || attempt !== undefined
              ? [{ value: 'reset', label: 'Показать все проверки' }]
              : []),
            ...(page.nextOffset === undefined
              ? []
              : [{ value: 'next', label: 'Следующая страница →' }]),
            ...(offset ? [{ value: 'previous', label: '← Предыдущая страница' }] : []),
            { value: 'back', label: '← К проекту' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'phase')
      await projectChoice(
        'Фаза проверки',
        [
          { value: 'all', label: 'Все фазы' },
          ...Object.entries(phaseLabels).map(([value, label]) => ({ value, label })),
        ],
        async (value) => {
          phase = value === 'all' ? undefined : (value as typeof phase);
          offset = 0;
        },
      );
    if (choice === 'stage') {
      const view = await context.request('projects.detail', { projectId });
      await projectChoice(
        'Этап',
        [
          { value: 'all', label: 'Все этапы' },
          ...view.stages.map((stage) => ({ value: stage.stageId, label: stage.title })),
        ],
        async (value) => {
          stageId = value === 'all' ? undefined : value;
          offset = 0;
        },
      );
    }
    if (choice === 'attempt')
      await projectField(
        'Номер попытки · пусто означает все',
        attempt === undefined ? '' : String(attempt),
        async (value) => {
          if (!value || (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) {
            attempt = value ? Number(value) : undefined;
            offset = 0;
          }
        },
      );
    if (choice === 'reset') {
      phase = undefined;
      stageId = undefined;
      attempt = undefined;
      offset = 0;
    }
    if (choice === 'next') offset += 20;
    if (choice === 'previous') offset = Math.max(0, offset - 20);
    if (choice.includes('/')) {
      const separator = choice.indexOf('/');
      const reportId = choice.slice(0, separator),
        checkId = choice.slice(separator + 1);
      const report = reports.find((item) => item.id === reportId);
      const check = report?.checks.find((item) => item.id === checkId);
      if (report && check) await inspectProjectCheck(context, projectId, report, check);
      else if (report)
        await readText('Ручная проверка', [
          {
            id: 'manual',
            label: 'Результат',
            text: `${report.at}\n${report.note ?? 'Результат ещё не сохранён.'}`,
          },
        ]);
    }
  }
}
