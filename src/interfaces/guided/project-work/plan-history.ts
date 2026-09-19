import type { CommandResponse } from '../../contracts/index.js';
import type { CliContext } from '../../types.js';
import { readText } from '../text-reader.js';
import { liveSelect } from '../live-select.js';
import { planText } from './format.js';

type Comparison = CommandResponse<'projects.comparePlans'>;
const fieldLabels: Record<string, string> = {
  title: 'Название',
  task: 'Задача',
  role: 'Специалист',
  dependsOn: 'Зависимости',
  expectedResult: 'Критерий результата',
  requiredTools: 'Инструменты',
  command: 'Программа',
  args: 'Аргументы',
  verification: 'Проверка',
  instructions: 'Ручная проверка',
  maxCorrections: 'Предел исправлений',
  fixBaselineFailures: 'Исправление исходных ошибок',
  order: 'Порядок',
  stage: 'Состав этапа',
  check: 'Состав проверки',
  'stages.order': 'Порядок этапов',
  'checks.order': 'Порядок проверок',
  'check.title': 'Название проверки',
  'check.command': 'Программа проверки',
  'check.args': 'Буквальные аргументы',
  'verification.kind': 'Способ проверки',
  'verification.instructions': 'Инструкция ручной проверки',
};
/** Сравнение сохраняет границы argv и показывает изменения по устойчивым ID. */
export function comparisonText(comparison: Comparison): string {
  if (!comparison.before) return 'Первый план · полный состав\n\n' + planText(comparison.after);
  return [
    `Сравнение: версия ${comparison.fromVersion ?? 'до изменений'} → ${comparison.toVersion ?? 'черновик'}`,
    ...comparison.changes.map((change) => {
      const stage =
        comparison.after.stages.find((item) => item.id === change.stageId) ??
        comparison.before?.stages.find((item) => item.id === change.stageId);
      return [
        `${{ added: 'Добавлено', removed: 'Удалено', changed: 'Изменено', reordered: 'Новый порядок' }[change.kind]} · ${stage?.title ?? 'План'}`,
        change.checkId ? 'Проверка: ' + change.checkId : '',
        fieldLabels[change.field] ?? change.field,
        change.before === undefined ? '' : 'Было: ' + formatValue(change.before),
        change.after === undefined ? '' : 'Стало: ' + formatValue(change.after),
      ]
        .filter(Boolean)
        .join('\n');
    }),
    comparison.changes.length ? '' : 'Изменений нет.',
  ]
    .filter(Boolean)
    .join('\n\n');
}
/** Массивы выводятся как JSON, чтобы пустой аргумент и пробелы не исчезали при сравнении. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** История читает страницы производного индекса и сравнивает выбранную редакцию с текущей. */
export async function inspectPlanVersions(context: CliContext, projectId: string): Promise<void> {
  let offset = 0;
  while (true) {
    const choice = await liveSelect({
      title: 'Сохранённые версии плана',
      load: async () => {
        const page = await context.request('projects.planVersions', { projectId, offset });
        return {
          message: 'Выберите версию для сравнения',
          summary: `Версий: ${page.total}`,
          options: [
            ...page.items.map((item) => ({
              value: `version:${item.version}`,
              label: `Версия ${item.version}${item.accepted ? ' · принята' : ''}`,
              hint: `${item.stageCount} этапов · ${item.createdAt}`,
            })),
            ...(page.nextOffset === undefined
              ? []
              : [{ value: 'next', label: 'Следующие версии →' }]),
            ...(offset ? [{ value: 'previous', label: '← Предыдущие версии' }] : []),
            { value: 'back', label: '← К проекту' },
          ],
        };
      },
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'next') offset += 20;
    if (choice === 'previous') offset = Math.max(0, offset - 20);
    if (choice.startsWith('version:')) {
      const load = async () => ({
        tabs: [
          {
            id: 'diff',
            label: 'Изменения',
            text: comparisonText(
              await context.request('projects.comparePlans', {
                projectId,
                fromVersion: Number(choice.slice(8)),
              }),
            ),
          },
        ],
      });
      await readText('Сравнение планов', (await load()).tabs, { load });
    }
  }
}
