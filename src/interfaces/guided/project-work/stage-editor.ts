import type { ProjectPlan, ProjectStage, ProjectView } from '../../../projects/types.js';
import { id } from '../../../shared/primitives.js';
import { liveSelect } from '../live-select.js';
import { readText } from '../text-reader.js';
import { planText } from './format.js';
import { projectChoice, projectField, chooseProjectSet } from './form-input.js';
import { editStageVerification } from './check-editor.js';

/** Новый этап получает собственные идентификаторы и ручную проверку до выбора команд. */
export function freshStage(view: ProjectView, source?: ProjectStage): ProjectStage {
  if (source)
    return {
      ...structuredClone(source),
      id: id(),
      title: source.title.slice(0, 500 - ' · копия'.length) + ' · копия',
      verification:
        source.verification.kind === 'manual'
          ? structuredClone(source.verification)
          : {
              kind: 'commands',
              checks: source.verification.checks.map((check) => ({
                ...structuredClone(check),
                id: id(),
              })),
            },
    };
  return {
    id: id(),
    title: 'Новый этап',
    task: '',
    role: view.roles[0]?.id ?? '',
    dependsOn: [],
    expectedResult: '',
    requiredTools: [],
    verification: { kind: 'manual', instructions: 'Проверьте ожидаемый результат этапа.' },
  };
}

/** Завершённые этапы открываются только для чтения, остальные меняются в сохранённом черновике. */
export async function editStage(
  view: ProjectView,
  initial: ProjectStage,
  getPlan: () => ProjectPlan,
  save: (stage: ProjectStage) => Promise<void>,
): Promise<void> {
  if (view.stages.some((item) => item.stageId === initial.id && item.status === 'completed')) {
    await readText('Завершённый этап · только чтение', [
      {
        id: 'stage',
        label: 'Этап',
        text: planText({ ...getPlan(), stages: [initial] }, view.roles),
      },
    ]);
    return;
  }
  let stage = structuredClone(initial);
  const update = async (next: ProjectStage) => {
    stage = next;
    await save(next);
  };
  while (true) {
    const choice = await liveSelect({
      title: stage.title || 'Редактор этапа',
      load: async () => ({
        summary: `Специалист: ${view.roles.find((role) => role.id === stage.role)?.label ?? stage.role}\nОжидалось: ${stage.expectedResult || 'Укажите результат'}`,
        message: 'Параметры этапа',
        options: [
          { value: 'title', label: 'Название' },
          { value: 'task', label: 'Задача специалисту' },
          { value: 'role', label: 'Специалист' },
          { value: 'dependsOn', label: 'Зависимости от этапов' },
          { value: 'expectedResult', label: 'Ожидаемый результат' },
          { value: 'requiredTools', label: 'Нужные инструменты' },
          { value: 'verification', label: 'Как проверить результат' },
          { value: 'back', label: '← К плану' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'title' || choice === 'task' || choice === 'expectedResult')
      await projectField(
        {
          title: 'Название этапа',
          task: 'Задача специалисту',
          expectedResult: 'Ожидаемый результат',
        }[choice],
        stage[choice],
        async (value) => update({ ...stage, [choice]: value }),
        { limit: { title: 500, task: 32000, expectedResult: 8000 }[choice] },
      );
    if (choice === 'role')
      await projectChoice(
        'Выберите специалиста',
        view.roles.map((role) => ({ value: role.id, label: role.label })),
        async (role) => update({ ...stage, role }),
      );
    if (choice === 'dependsOn')
      await chooseProjectSet(
        'После каких этапов начать?',
        getPlan()
          .stages.filter((item) => item.id !== stage.id)
          .map((item) => ({ value: item.id, label: item.title })),
        stage.dependsOn,
        async (dependsOn) => update({ ...stage, dependsOn }),
      );
    if (choice === 'requiredTools')
      await chooseProjectSet(
        'Инструменты из настроек проекта',
        (view.tools ?? []).map((name) => ({ value: name, label: name })),
        stage.requiredTools,
        async (requiredTools) => update({ ...stage, requiredTools }),
      );
    if (choice === 'verification')
      await editStageVerification(stage.verification, async (verification) =>
        update({ ...stage, verification }),
      );
  }
}
