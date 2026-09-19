import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { id } from '../../../shared/primitives.js';
import { liveSelect } from '../live-select.js';
import { liveConfirm } from '../live-confirm.js';
import { readText } from '../text-reader.js';
import { checkCommand } from './format.js';
import { browseProjectReports } from './reports.js';

/** Предпросмотр показывает пользовательские команды и состав журналов до создания файла. */
export function projectExportText(preview: CommandResponse<'projects.exportPreview'>): string {
  return [
    `Формат: ${preview.format === 'markdown' ? 'Markdown' : 'JSON'}`,
    `Куда: ${preview.destination}`,
    `Журналы: ${preview.includeLogs ? 'включены' : 'не включены'}`,
    '\nСостав:',
    ...preview.sections,
    '\nКоманды пользователя:',
    ...preview.commands.map((command) => checkCommand(command.command, command.args)),
    ...(preview.includeLogs
      ? [
          '\nСохранённые журналы:',
          ...preview.logs.map((log) =>
            [
              `${log.checkId}: ${log.available ? `stdout ${log.stdoutCharacters} символов${log.stdoutTruncated ? ' (обрезан)' : ''}; stderr ${log.stderrCharacters} символов${log.stderrTruncated ? ' (обрезан)' : ''}` : 'доказательство недоступно'}`,
              log.stdoutPreview ? 'Начало stdout:\n' + log.stdoutPreview : '',
              log.stderrPreview ? 'Начало stderr:\n' + log.stderrPreview : '',
            ]
              .filter(Boolean)
              .join('\n'),
          ),
        ]
      : []),
    ...preview.warnings,
  ].join('\n');
}

/** Экспорт создаётся в состоянии Harness; изменение проекта отзывает показанный предпросмотр. */
export async function exportProject(context: CliContext, projectId: string): Promise<void> {
  let format: 'markdown' | 'json' = 'markdown',
    includeLogs = false;
  while (true) {
    const choice = await liveSelect({
      title: 'Экспорт результата проекта',
      load: async () => ({
        summary:
          'Цель, принятый план, результаты, изменения файлов и проверки. Подключения и настройки не включаются.',
        message: 'Состав отчёта',
        options: [
          { value: 'preview', label: 'Предпросмотр и сохранение' },
          { value: 'format', label: 'Формат', hint: format === 'markdown' ? 'Markdown' : 'JSON' },
          {
            value: 'logs',
            label: 'Включить stdout и stderr',
            hint: includeLogs ? 'да · могут содержать данные команд' : 'нет',
          },
          { value: 'readLogs', label: 'Открыть журналы перед экспортом' },
          { value: 'back', label: '← К проекту' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'readLogs') await browseProjectReports(context, projectId);
    if (choice === 'format') format = format === 'markdown' ? 'json' : 'markdown';
    if (choice === 'logs') includeLogs = !includeLogs;
    if (choice !== 'preview') continue;
    const view = await context.request('projects.detail', { projectId });
    const preview = await context.request('projects.exportPreview', {
      projectId,
      expectedRevision: view.revision,
      format,
      includeLogs,
    });
    if (
      (await readText(
        'Предпросмотр экспорта',
        [{ id: 'content', label: 'Состав', text: projectExportText(preview) }],
        { actionLabel: 'подтвердить сохранение' },
      )) !== 'action'
    )
      continue;
    if (
      (await liveConfirm({
        title: 'Сохранить отчёт',
        message: 'Создать показанный файл?',
        active: 'Сохранить',
        inactive: 'Назад',
        body: preview.destination,
        load: async () => {
          const current = await context.request('projects.detail', { projectId });
          return {
            available: current.revision === preview.revision,
            detail:
              current.revision === preview.revision
                ? 'Состав подтверждён'
                : 'Проект изменился · нужен новый предпросмотр',
          };
        },
      })) !== true
    )
      continue;
    const request = {
      projectId,
      expectedRevision: preview.revision,
      previewToken: preview.previewToken,
      requestKey: id(),
      format,
      includeLogs,
    };
    while (true) {
      try {
        const result = await context.request('projects.exportReport', request);
        await readText('Отчёт сохранён', [
          {
            id: 'file',
            label: 'Файл',
            text: `${result.path}\nРазмер: ${result.bytes} байт\nРабочая папка проекта не изменялась.`,
          },
        ]);
        return;
      } catch (error) {
        const retry = await liveSelect({
          title: 'Сохранение отчёта не подтверждено',
          load: async () => ({
            summary: error instanceof Error ? error.message : String(error),
            message: 'Повтор использует тот же ключ и тот же состав.',
            options: [
              { value: 'retry', label: 'Проверить сохранение повторно' },
              { value: 'back', label: '← Вернуться к экспорту' },
            ],
          }),
        });
        if (retry !== 'retry') break;
      }
    }
  }
}
