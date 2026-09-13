import type { CliContext, StatusView } from '../types.js';
import type { UsageLedger } from '../../runtime/usage.js';
import { readText } from './text-reader.js';
import { isMissingResource } from '../../shared/resource-errors.js';
export type BudgetView = Awaited<ReturnType<UsageLedger['status']>>;

/** Только читает расход; данные провайдера показаны отдельно от оценки запросов Harness. */
export async function manageBudget(
  context: CliContext,
  run?: Pick<StatusView, 'runId' | 'status'>,
): Promise<'removed' | undefined> {
  const runId = run?.runId;
  const load = async () => {
    const [usage, current] = await Promise.all([
      context.request<BudgetView>('budget.status', { runId }),
      runId ? context.request<StatusView>('runtime.status', { runId }) : undefined,
    ]);
    const text = [
      ...(current
        ? [
            'Провайдер сообщил',
            'Вход: ' + current.usage.input,
            'Выход: ' + current.usage.output,
            'Всего: ' + (current.usage.input + current.usage.output),
            '',
            'Оценка Harness: ' + usage.runReserved,
          ]
        : [
            'Сегодня (UTC): ' + usage.date,
            '',
            'Провайдер сообщил',
            'Задачи: ' + usage.daily.reportedTasks,
            'Обучение: ' + usage.daily.reportedLearning,
            'Всего: ' + (usage.daily.reportedTasks + usage.daily.reportedLearning),
            '',
            'Оценка Harness',
            'Задачи: ' + usage.daily.tasks,
            'Обучение: ' + usage.daily.learning,
            'Всего: ' + (usage.daily.tasks + usage.daily.learning),
          ]),
      '',
      'Оценка включает запас на ответ, повторные запросы и неизвестные результаты.',
      'Суммы указаны в токенах, не в деньгах.',
    ].join('\n');
    return { tabs: [{ id: 'usage', label: 'Токены', text }] };
  };
  try {
    await readText(runId ? 'Расход токенов задачи' : 'Расход токенов', (await load()).tabs, {
      load,
      exitOnError: (error) => !!runId && isMissingResource(error, 'task'),
    });
  } catch (error) {
    if (!runId || !isMissingResource(error, 'task')) throw error;
    await readText('Задача удалена', [
      {
        id: 'removed',
        label: 'Задача',
        text: 'Задача удалена в другом окне. Esc — к списку задач.',
      },
    ]);
    return 'removed';
  }
}
