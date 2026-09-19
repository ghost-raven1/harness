import * as prompts from '@clack/prompts';
import type { CliContext, StatusView } from '../types.js';
import { selected } from '../ui.js';
import { page } from './screen.js';
import { liveConfirm } from './live-confirm.js';

/** Проводит человека через проверку оборванного отката, сохраняя фактическое содержимое файла. */
export async function reviewRestorations(
  context: CliContext,
  status: StatusView,
): Promise<boolean> {
  for (const change of status.fileChanges ?? []) {
    if (change.status !== 'restoring') continue;
    const selection = { runId: status.runId, changeId: change.id };
    const preview = await context.request('files.previewResolution', selection);
    page('Проверка восстановления файла');
    const result = selected(
      await prompts.text({
        message: preview.path + '\n' + preview.description + '\nПроверьте файл и опишите результат',
        validate: (text) =>
          text.trim() && text.trim().length <= 10000
            ? undefined
            : 'Опишите проверку: от 1 до 10 000 символов',
      }),
    );
    const confirmed = selected(
      (await liveConfirm({
        title: 'Проверка восстановления файла',
        message: 'Сохранить результат проверки, оставив файл как есть?',
        body: preview.path + '\n' + preview.description + '\n\nВаш результат: ' + result,
        active: 'Сохранить проверку',
        inactive: 'Проверить позже',
        load: async () => {
          const current = await context.request('runtime.status', {
            runId: status.runId,
          });
          if (
            !current.fileChanges?.some(
              (item) => item.id === change.id && item.status === 'restoring',
            )
          )
            return { available: false, detail: 'Результат уже проверен в другом окне.' };
          const actual = await context.request('files.previewResolution', selection);
          const available = actual.previewToken === preview.previewToken;
          return {
            available,
            detail: available ? actual.description : 'Файл изменился. Откройте проверку заново.',
          };
        },
      })) ?? false,
    );
    if (!confirmed) return false;
    await context.request('files.resolveRestore', {
      ...selection,
      previewToken: preview.previewToken,
      result,
    });
  }
  return true;
}
