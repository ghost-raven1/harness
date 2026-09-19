import * as prompts from '@clack/prompts';
import type { ProjectPlan, ProjectView } from '../../../projects/types.js';
import { id } from '../../../shared/primitives.js';
import type { CliContext } from '../../types.js';
import { selected } from '../../ui.js';
import { page } from '../screen.js';
import { confirmProject } from './confirm.js';
import { planText } from './format.js';
import { projectDraft, submitProjectDraft } from './drafts.js';
import { readText } from '../text-reader.js';
import { comparisonText } from './plan-history.js';

/** Передаёт пожелания к плану обычным текстом с сохранением неподтверждённой отправки. */
export async function requestPlan(context: CliContext, view: ProjectView): Promise<void> {
  if (!view.plan) {
    await context.request('projects.plan', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: id(),
    });
    return;
  }
  const draft = await projectDraft(
    context,
    {
      workspace: view.workspace,
      profile: view.profile,
      projectId: view.projectId,
      purpose: 'project.plan',
    },
    'Что изменить в плане?',
    view,
    16000,
  );
  await submitProjectDraft(context, draft, () =>
    context.request('projects.plan', {
      projectId: view.projectId,
      expectedRevision: draft.expectedProjectRevision ?? view.revision,
      requestKey: draft.requestKey,
      feedback: draft.text,
    }),
  );
}
/** Новая редакция не запускается, пока человек не примет её команды и ручные проверки. */
export async function editPlanOption(
  context: CliContext,
  view: ProjectView,
  baseline = false,
): Promise<void> {
  if (!view.plan) return;
  const { version: _version, ...plan } = view.plan;
  let next: ProjectPlan;
  if (baseline) next = { ...plan, fixBaselineFailures: true };
  else {
    page('Предел исправлений');
    const value = selected(
      await prompts.text({
        message: 'Сколько исправлений разрешить каждому этапу? От 0 до 10.',
        initialValue: String(plan.maxCorrections),
        validate: (text) =>
          /^\d+$/.test(text) && Number(text) <= 10 ? undefined : 'Введите число от 0 до 10.',
      }),
    );
    next = { ...plan, maxCorrections: Number(value) };
  }
  if (
    await confirmProject(
      context,
      view,
      'editPlan',
      'Сохранить новую версию плана?',
      planText(next, view.roles),
      'Сохранить',
    )
  )
    await context.request('projects.editPlan', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: id(),
      plan: next,
    });
}
/** Фиксирует именно прочитанную версию плана; автоматическое исполнение начинается после подтверждения. */
export async function acceptPlan(
  context: CliContext,
  view: ProjectView,
  enhanced = false,
): Promise<void> {
  if (!view.plan) return;
  if (enhanced) {
    const comparison = await context.request('projects.comparePlans', {
      projectId: view.projectId,
    });
    if (
      (await readText(
        'Перед принятием плана',
        [
          { id: 'diff', label: 'Изменения', text: comparisonText(comparison) },
          { id: 'plan', label: 'Полный план', text: planText(view.plan, view.roles) },
        ],
        { actionLabel: 'к подтверждению' },
      )) !== 'action'
    )
      return;
  }
  if (
    await confirmProject(
      context,
      view,
      'acceptPlan',
      'Принять план и начать выполнение?',
      'Версия плана: ' +
        view.plan.version +
        '\nПапка: ' +
        view.workspace +
        '\n\n' +
        planText(view.plan, view.roles),
      'Принять',
    )
  )
    await context.request('projects.acceptPlan', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: id(),
      expectedPlanVersion: view.plan.version,
    });
}
