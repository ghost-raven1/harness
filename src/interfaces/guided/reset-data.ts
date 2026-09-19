import type { CliContext } from '../types.js';
import type { DataResetPreview, DataResetScope } from '../../application/data-reset.js';
import { liveSelect } from './live-select.js';
import { liveConfirm } from './live-confirm.js';
import { readText } from './text-reader.js';
import { explainError } from './errors.js';

const labels: Record<DataResetScope, string> = {
  tasks: 'Проекты, задачи и история',
  learning: 'Накопленные знания',
  all: 'Проекты, задачи, история и знания',
};
const retained: Record<DataResetScope, string> = {
  tasks:
    'Знания и их доказательства сохранятся. Доказательства могут содержать фрагменты прежних задач.',
  learning:
    'История задач сохранится, включая уже использованные в ней знания. Новые задачи начнут без накопленного опыта.',
  all: 'Будут удалены все проекты, задачи, история, знания и их доказательства.',
};

/** Сначала выбирается состав очистки; удаление доступно только после отдельного подтверждения. */
export async function resetData(context: CliContext, scope?: DataResetScope): Promise<void> {
  if (scope) {
    await confirmDataReset(context, scope);
    return;
  }
  while (true) {
    const choice = await liveSelect<DataResetScope | 'back'>({
      title: 'Очистка данных',
      load: async () => {
        const current = await context.request('maintenance.resetPreview', {
          scope: 'all',
        });
        return {
          summary:
            'Переписок: ' +
            current.sessions +
            '\nПроектов: ' +
            (current.projects ?? 0) +
            '\nУроков: ' +
            current.lessons +
            '\nНастройки и файлы проектов сохранятся.',
          summaryTitle: 'Данные Harness',
          message: 'Что очистить?',
          options: [
            { value: 'tasks', label: labels.tasks, hint: 'знания останутся' },
            { value: 'learning', label: labels.learning, hint: 'задачи останутся' },
            { value: 'all', label: labels.all, hint: 'настройки останутся' },
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (await confirmDataReset(context, choice)) return;
  }
}

/** Подтверждение закрепляет состав данных, чтобы другой клиент не расширил область очистки. */
export async function confirmDataReset(
  context: CliContext,
  scope: DataResetScope,
): Promise<boolean> {
  const load = () => context.request('maintenance.resetPreview', { scope });
  try {
    const preview = await load();
    if (!preview.available) {
      const blocked = (current: DataResetPreview) => ({
        tabs: [
          {
            id: 'blocked',
            label: 'Что нужно сделать',
            text: current.available
              ? 'Теперь очистка доступна. Вернитесь назад и выберите состав заново.'
              : current.blockers.join('\n\n'),
          },
        ],
      });
      await readText('Очистка пока недоступна', blocked(preview).tabs, {
        load: async () => blocked(await load()),
      });
      return false;
    }
    const confirmed = await liveConfirm({
      title: 'Очистка данных · ' + labels[scope],
      message: 'Удалить выбранные данные навсегда?',
      body: [
        labels[scope],
        'Настройки, подключения и файлы проектов сохранятся.',
        retained[scope],
        '',
        'Проектов: ' + (preview.projects ?? 0),
        'Переписок: ' + preview.sessions + ' · этапов: ' + preview.tasks,
        'Уроков: ' + preview.lessons + ' · источников: ' + preview.evidence,
        'Заданий обучения: ' + preview.jobs,
        'Артефактов: ' + preview.artifacts,
        'Копий для отмены изменений: ' + preview.backups,
        'Экспортов уроков внутри Harness: ' + preview.exports,
        '',
        'Диагностические логи сохранятся.',
        'Отменить очистку нельзя. Расход API и защита от повторного запроса сохранятся.',
        scope !== 'learning'
          ? 'Сохранённые в проекте ответы останутся. Восстановление файлов через удалённые задачи станет недоступно.'
          : '',
      ].join('\n'),
      active: 'Удалить',
      inactive: 'Оставить',
      load: async () => {
        const current = await load();
        const unchanged = current.previewToken === preview.previewToken;
        return {
          available: current.available && unchanged,
          detail: !current.available
            ? current.blockers.join(' ')
            : !unchanged
              ? 'Состав изменился. Вернитесь к выбору очистки.'
              : '',
        };
      },
    });
    if (confirmed !== true) return false;
    await context.request('maintenance.reset', { scope, previewToken: preview.previewToken });
    await readText('Данные очищены', [
      {
        id: 'result',
        label: 'Результат',
        text:
          'Очищено: ' +
          labels[scope] +
          '.\n\n' +
          (scope === 'all'
            ? 'Задачи и знания удалены из Harness.'
            : scope === 'tasks'
              ? 'Знания и их доказательства сохранены.'
              : 'История задач сохранена. Новые задачи начнут без накопленного опыта.') +
          '\n\nПодключения, настройки и файлы проектов сохранены.',
      },
    ]);
    return true;
  } catch (error) {
    await readText('Очистка не выполнена', [
      {
        id: 'error',
        label: 'Причина',
        text: explainError(error),
      },
    ]);
    return false;
  }
}
