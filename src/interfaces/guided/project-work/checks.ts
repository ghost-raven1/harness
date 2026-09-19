import * as prompts from '@clack/prompts';
import type { ProjectView } from '../../../projects/types.js';
import { id } from '../../../shared/primitives.js';
import type { CliContext } from '../../types.js';
import { selected } from '../../ui.js';
import { liveSelect } from '../live-select.js';
import { page } from '../screen.js';
import { readText } from '../text-reader.js';
import { checkInterrupted } from '../interrupted-task.js';
import { confirmProject } from './confirm.js';

/** Ручная проверка закрепляется за конкретным этапом и снимком его результата. */
export async function manualProjectCheck(context: CliContext, view: ProjectView): Promise<void> {
  const stageId = selected(
    await liveSelect({
      title: 'Ручная проверка',
      load: async () => {
        const current = await context.request('projects.detail', { projectId: view.projectId });
        return {
          message: 'Какой этап вы проверили?',
          options: [
            ...current.stages
              .filter(
                (stage) =>
                  current.plan?.stages.some(
                    (definition) =>
                      definition.id === stage.stageId && definition.verification.kind === 'manual',
                  ) && stage.manualRevision !== current.resultRevision,
              )
              .map((stage) => ({ value: stage.stageId, label: stage.title })),
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (stageId === 'back') return;
  const current = await context.request('projects.detail', { projectId: view.projectId });
  const stage = current.stages.find((item) => item.stageId === stageId);
  const definition = current.plan?.stages.find((item) => item.id === stageId);
  if (!stage || !current.resultRevision || definition?.verification.kind !== 'manual') return;
  const instructions = [
    { id: 'instructions', label: 'Проверка', text: definition.verification.instructions },
  ];
  if (
    (await readText(stage.title, instructions, {
      actionLabel: 'Указать результат',
      load: async () => {
        const latest = await context.request('projects.detail', { projectId: view.projectId });
        const available =
          latest.revision === current.revision && latest.allowedActions.includes('manualCheck');
        return {
          tabs: instructions,
          actionLabel: available ? 'Указать результат' : '',
          notice: available
            ? 'Проверьте результат по этим инструкциям.'
            : 'Проект изменился. Вернитесь к актуальной карточке.',
        };
      },
    })) !== 'action'
  )
    return;
  const outcome = selected(
    await liveSelect<'passed' | 'failed' | 'back'>({
      title: stage.title,
      load: async () => {
        const latest = await context.request('projects.detail', { projectId: view.projectId });
        const available =
          latest.revision === current.revision && latest.allowedActions.includes('manualCheck');
        return {
          summaryTitle: 'Что проверить',
          summary:
            definition.verification.kind === 'manual' ? definition.verification.instructions : '',
          message: 'Результат вашей проверки',
          options: [
            { value: 'back', label: 'Проверить позже' },
            ...(available
              ? [
                  { value: 'passed' as const, label: 'Всё работает' },
                  { value: 'failed' as const, label: 'Есть ошибка' },
                ]
              : []),
          ],
        };
      },
    }),
  );
  if (outcome === 'back') return;
  page('Результат ручной проверки');
  const comment = selected(
    await prompts.text({
      message: 'Что проверено и что получилось?',
      validate: (value) =>
        value.trim() && value.length <= 8000 ? undefined : 'Опишите результат, до 8 000 символов.',
    }),
  );
  if (
    await confirmProject(
      context,
      current,
      'manualCheck',
      'Зафиксировать проверенный результат?',
      definition.verification.instructions +
        '\n\n' +
        (outcome === 'passed' ? 'Всё работает' : 'Есть ошибка') +
        '\n' +
        comment,
    )
  )
    await context.request('projects.manualCheck', {
      projectId: view.projectId,
      expectedRevision: current.revision,
      requestKey: id(),
      stageId,
      expectedResultRevision: current.resultRevision,
      outcome,
      comment,
    });
}

/** Переиспользует проверку неизвестного эффекта, сохраняя управление в проекте. */
export async function resolveProjectOperation(
  context: CliContext,
  view: ProjectView,
): Promise<void> {
  const runId = view.blockers.find((item) => item.runId)?.runId ?? view.currentRunId;
  if (!runId) return;
  const status = await context.request('runtime.status', { runId });
  await checkInterrupted(context, status, async (input) => {
    const current = await context.request('projects.detail', { projectId: view.projectId });
    await context.request('projects.resolve', {
      projectId: view.projectId,
      expectedRevision: current.revision,
      requestKey: id(),
      ...input,
    });
  });
}
