import * as prompts from '@clack/prompts';
import type { IterationStatus } from '../../runtime/iterations.js';
import { isMissingResource } from '../../shared/resource-errors.js';
import type { CliContext } from '../types.js';
import { explainError } from './errors.js';
import { liveConfirm } from './live-confirm.js';
import { liveSelect } from './live-select.js';
import { page } from './screen.js';
import { readText } from './text-reader.js';

function summary(status: IterationStatus): string {
  const run = status.run;
  if (!run)
    return (
      'Для новых задач: ' +
      status.defaultLimit +
      ' шагов.\nРаботающие задачи сохраняют свой предел.'
    );
  return [
    'В порции: ' + run.used + ' / ' + run.limit + ' шагов',
    'Всего выполнено: ' + run.total,
    'Осталось в порции: ' + run.remaining,
    run.pausedByLimit && 'Достигнут предел. Задача на паузе.',
    run.editable
      ? 'После продолжения будет ещё ' + run.limit + ' шагов.'
      : 'Изменение доступно на паузе.',
  ]
    .filter(Boolean)
    .join('\n');
}

function validateLimit(value: string): string | undefined {
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
    return 'Введите положительное целое число, не больше ' + Number.MAX_SAFE_INTEGER + '.';
}

/** Сохраняет предел только после подтверждения актуального значения и состояния задачи. */
async function editLimit(
  context: CliContext,
  current: IterationStatus,
  runId?: string,
): Promise<string> {
  if (runId && !current.run?.editable) return 'Изменение доступно на паузе.';
  const expectedLimit = current.run?.limit ?? current.defaultLimit;
  const title = runId ? 'Предел шагов задачи' : 'Предел шагов';
  page(title);
  const input = await prompts.text({
    message: 'Сколько шагов в одной порции?',
    initialValue: String(expectedLimit),
    validate: validateLimit,
  });
  if (typeof input === 'symbol') return '';
  const validation = validateLimit(input);
  if (validation) return validation;
  const limit = Number(input);
  let removed: unknown;
  let notice = '';
  const check = async () => {
    try {
      const latest = await context.request<IterationStatus>('iterations.status', { runId });
      notice =
        runId && !latest.run?.editable
          ? 'Изменение доступно на паузе'
          : (latest.run?.limit ?? latest.defaultLimit) !== expectedLimit
            ? 'Предел уже изменён в другом окне'
            : '';
      return { available: !notice, detail: notice || 'Текущий предел: ' + expectedLimit };
    } catch (error) {
      if (!runId || !isMissingResource(error, 'task')) throw error;
      removed = error;
      return { available: false, detail: 'Задача удалена' };
    }
  };
  const confirmed = await liveConfirm({
    title,
    message: 'Сохранить предел шагов?',
    active: 'Сохранить',
    inactive: 'Назад',
    body: [
      'Сейчас: ' + expectedLimit + ' шагов.',
      'После изменения: ' + limit + ' шагов.',
      '',
      runId
        ? 'При продолжении эта задача получит новую порцию шагов. История и общий счётчик сохранятся.'
        : 'Этот предел будет у новых задач. Текущие задачи сохранят свои настройки.',
      'Достигнув предела, задача сохранится на паузе.',
    ].join('\n'),
    load: check,
  });
  if (removed) throw removed;
  if (confirmed !== true) return notice;
  const latest = await check();
  if (removed) throw removed;
  if (!latest.available) return notice;
  await context.request('iterations.configure', {
    limit,
    expectedLimit,
    ...(runId ? { runId } : {}),
  });
  return 'Предел сохранён: ' + limit + ' шагов.';
}

/** Показывает общую порцию шагов всех агентов; работающую задачу можно только просматривать. */
export async function showIterationSettings(
  context: CliContext,
  runId?: string,
): Promise<'removed' | undefined> {
  const title = runId ? 'Предел шагов задачи' : 'Предел шагов';
  const load = () => context.request<IterationStatus>('iterations.status', { runId });
  let removed = false;
  let notice = '';
  while (true) {
    const action = await liveSelect({
      title,
      load: async () => {
        try {
          if (!removed) {
            const status = await load();
            return {
              message: 'Что сделать?',
              summaryTitle: title,
              summary: [notice, summary(status)].filter(Boolean).join('\n'),
              options: [
                ...(!runId || status.run?.editable
                  ? [{ value: 'edit', label: 'Изменить предел' }]
                  : []),
                { value: 'details', label: 'Как считаются шаги' },
                { value: 'back', label: '← Назад' },
              ],
            };
          }
        } catch (error) {
          if (!runId || !isMissingResource(error, 'task')) throw error;
          removed = true;
        }
        return {
          message: 'Задача удалена',
          summary: 'Задача удалена в другом окне.',
          options: [{ value: 'back', label: '← К списку задач' }],
        };
      },
    });
    if (removed) return 'removed';
    if (typeof action === 'symbol' || action === 'back') return;
    notice = '';
    try {
      if (action === 'edit') notice = await editLimit(context, await load(), runId);
      if (action === 'details') {
        const details = async () => ({
          tabs: [
            {
              id: 'steps',
              label: 'Шаги',
              text: [
                summary(await load()),
                '',
                'Один шаг — один цикл обращения к модели. Все агенты и подзадачи расходуют общую порцию.',
                'При достижении предела задача сохраняется на паузе.',
                '«Продолжить после паузы» даёт новую порцию шагов. Общий счётчик и история сохраняются.',
                'Общая настройка действует на новые задачи. Предел существующей задачи можно изменить, пока она на паузе.',
              ].join('\n'),
            },
          ],
        });
        await readText('Как считаются шаги', (await details()).tabs, {
          load: details,
          exitOnError: (error) => !!runId && isMissingResource(error, 'task'),
        });
      }
    } catch (error) {
      if (runId && isMissingResource(error, 'task')) removed = true;
      else notice = explainError(error);
    }
  }
}
