import type { CliContext, StatusView } from '../types.js';
import { labels } from '../ui.js';
import { readText, type TextTab } from './text-reader.js';
import { isMissingResource } from '../../shared/resource-errors.js';
import { showRemovedTask } from './task-removed.js';

const fileStates = {
  prepared: 'Подготовлена запись',
  applied: 'Изменён',
  restoring: 'Восстанавливается',
  restored: 'Восстановлен',
};

/** Полные сведения читаются по вкладкам и не вытесняют управление за край окна. */
export function taskDetails(status: StatusView): TextTab[] {
  const retryAt = status.providerPause?.retryAt;
  const retryTime =
    retryAt && Number.isFinite(Date.parse(retryAt))
      ? new Date(retryAt).toLocaleString('ru-RU')
      : undefined;
  return [
    {
      id: 'task',
      label: 'Задача',
      text: [
        status.task ?? 'Текст задачи недоступен.',
        '\nРабочая папка\n' + status.workspace,
        '\nСостояние: ' + (labels[status.status] ?? status.status),
        ...(status.status === 'paused' && status.pauseReason === 'provider'
          ? [
              status.providerPause?.kind === 'quota'
                ? 'Провайдер: исчерпана квота или баланс аккаунта.'
                : 'Провайдер: временно ограничена частота запросов.',
              ...(retryTime ? ['Повторить после ' + retryTime + ' (местное время).'] : []),
            ]
          : []),
        ...(status.deletedAt ? ['Скрыта из списка: ' + status.deletedAt] : []),
        'ID задачи: ' + status.runId,
        'Сессия: ' + status.sessionId,
      ].join('\n'),
    },
    {
      id: 'execution',
      label: 'Выполнение',
      text: [
        'Профиль модели: ' + status.profile,
        'Шагов: ' + status.turns,
        ...(status.iterations
          ? [
              'До паузы: ' + status.iterations.remaining + ' шагов',
              'Шагов в одной порции: ' + status.iterations.limit,
            ]
          : []),
        'Токены: ' + status.usage.input + ' вход / ' + status.usage.output + ' выход',
        status.learningVersion === 'baseline'
          ? 'Опыт: начальные инструкции, без накопленных знаний'
          : 'Версия накопленного опыта: ' + status.learningVersion,
        '\nРоли',
        ...status.agents.map(
          (agent) =>
            agent.role + ' · ' + (labels[agent.status] ?? agent.status) + '\nID: ' + agent.id,
        ),
      ].join('\n'),
    },
    {
      id: 'files',
      label: 'Файлы',
      text: status.fileChanges?.length
        ? status.fileChanges
            .map(
              (change) =>
                change.path + '\nСостояние: ' + fileStates[change.status] + '\nID: ' + change.id,
            )
            .join('\n\n')
        : 'Зарегистрированных изменений файлов нет.',
    },
    {
      id: 'errors',
      label: 'Ошибки',
      text: [
        status.error || 'Ошибок запуска нет.',
        ...(status.unknownInvocations.length
          ? [
              '\nНужна проверка фактического результата',
              ...status.unknownInvocations.map(
                (item) => item.tool + '\nID: ' + item.id + '\n' + (item.arguments ?? ''),
              ),
            ]
          : []),
      ].join('\n'),
    },
  ];
}

/** Перечитывает сведения, а удаление записи возвращает в каталог без старых данных. */
export async function showTaskDetails(
  context: CliContext,
  status: StatusView,
): Promise<'back' | 'removed'> {
  try {
    await readText('Сведения о задаче', taskDetails(status), {
      subtitle: status.deletedAt
        ? 'Скрыта · только чтение'
        : (labels[status.status] ?? status.status),
      load: async () => {
        const current = await context.request<StatusView>('runtime.status', {
          runId: status.runId,
        });
        return {
          tabs: taskDetails(current),
          subtitle: current.deletedAt
            ? 'Скрыта · только чтение'
            : (labels[current.status] ?? current.status),
        };
      },
      exitOnError: (error) => isMissingResource(error, 'task'),
    });
  } catch (error) {
    if (!isMissingResource(error, 'task')) throw error;
    await showRemovedTask();
    return 'removed';
  }
  return 'back';
}
