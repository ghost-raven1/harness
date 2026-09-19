import * as prompts from '@clack/prompts';
import type { CliContext, StatusView } from '../types.js';
import { selected } from '../ui.js';
import { page } from './screen.js';
import { liveConfirm } from './live-confirm.js';
import { liveSelect } from './live-select.js';
import { readText } from './text-reader.js';
import { reviewRestorations } from './restore-review.js';

/** Проверка нужна и убранной задаче: неизвестный исход нельзя обходить удалением или продолжением. */
export function hasInterruptedOperations(status: StatusView): boolean {
  if (status.recoveryRequired) return false;
  return (
    (['paused', 'cancelled', 'failed'].includes(status.status) &&
      status.unknownInvocations.length > 0) ||
    !!status.fileChanges?.some((change) => change.status === 'restoring')
  );
}

/** Фиксирует проверенный человеком результат; самостоятельного запуска работы здесь нет. */
export async function checkInterrupted(context: CliContext, status: StatusView): Promise<boolean> {
  for (const invocation of status.unknownInvocations) {
    let outcome: 'later' | 'success' | 'failed';
    while (true) {
      const choice = selected(
        await liveSelect<'later' | 'details' | 'success' | 'failed'>({
          title: 'Проверка прерванной операции',
          load: async () => {
            const current = await context.request<StatusView>('runtime.status', {
              runId: status.runId,
            });
            const pending = current.unknownInvocations.some((item) => item.id === invocation.id);
            return {
              summaryTitle: 'Нужна проверка результата',
              summary: pending
                ? invocation.tool +
                  '\nПроверьте файл или программу. Автоматического повтора не будет.'
                : 'Результат уже проверен. Вернитесь к задаче.',
              message: 'Что установлено после проверки?',
              options: [
                { value: 'later', label: 'Проверить позже' },
                ...(pending
                  ? [
                      { value: 'details' as const, label: 'Показать операцию и аргументы' },
                      { value: 'success' as const, label: 'Операция выполнилась' },
                      {
                        value: 'failed' as const,
                        label: 'Операция не выполнилась',
                        hint: 'или завершилась ошибкой',
                      },
                    ]
                  : []),
              ],
            };
          },
        }),
      );
      if (choice === 'details') {
        await readText('Проверяемая операция', [
          {
            id: 'operation',
            label: 'Аргументы',
            text: invocation.tool + '\n\n' + (invocation.arguments ?? ''),
          },
        ]);
        continue;
      }
      outcome = choice;
      break;
    }
    if (outcome === 'later') return false;
    page('Результат проверки');
    const result = selected(
      await prompts.text({
        message: 'Опишите фактический результат проверки',
        validate: (v) => (v.trim() ? undefined : 'Нужно описание проверенного результата'),
      }),
    );
    const confirmed = selected(
      (await liveConfirm({
        title: 'Проверка прерванной операции',
        message: 'Зафиксировать этот проверенный результат?',
        body:
          invocation.tool +
          '\n' +
          (invocation.arguments ?? '') +
          '\n\nВаш результат: ' +
          (outcome === 'success'
            ? 'Операция выполнилась'
            : 'Не выполнилась или завершилась ошибкой') +
          '\n' +
          result,
        active: 'Да',
        inactive: 'Назад',
        load: async () => {
          const current = await context.request<StatusView>('runtime.status', {
            runId: status.runId,
          });
          const available =
            ['paused', 'cancelled', 'failed'].includes(current.status) &&
            current.unknownInvocations.some((item) => item.id === invocation.id);
          return {
            available,
            detail: available
              ? 'Результат операции ещё не установлен'
              : 'Состояние операции изменилось',
          };
        },
      })) ?? false,
    );
    if (!confirmed) return false;
    const current = await context.request<StatusView>('runtime.status', { runId: status.runId });
    if (!['paused', 'cancelled', 'failed'].includes(current.status)) return false;
    if (!current.unknownInvocations.some((item) => item.id === invocation.id)) continue;
    await context.request('runtime.resolve', {
      runId: status.runId,
      invocationId: invocation.id,
      result,
      succeeded: outcome === 'success',
    });
  }
  return reviewRestorations(
    context,
    await context.request<StatusView>('runtime.status', { runId: status.runId }),
  );
}
