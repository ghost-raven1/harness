import type { ProjectStage } from '../../../projects/types.js';
import { id } from '../../../shared/primitives.js';
import { liveSelect } from '../live-select.js';
import { projectChoice, projectField } from './form-input.js';

type Verification = ProjectStage['verification'];
type Check = Extract<Verification, { kind: 'commands' }>['checks'][number];

/** Команда и аргументы редактируются раздельно; строки никогда не разбираются как shell. */
async function editCommand(initial: Check, save: (check: Check) => Promise<void>): Promise<void> {
  let check = structuredClone(initial);
  const update = async (next: Check) => {
    check = next;
    await save(check);
  };
  while (true) {
    const choice = await liveSelect({
      title: 'Команда проверки',
      load: async () => ({
        summary: `${check.title}\nПрограмма: ${check.command}\nАргументы передаются буквально; кавычки не нужны.`,
        message: 'Что изменить?',
        options: [
          { value: 'title', label: 'Название проверки' },
          { value: 'command', label: 'Программа', hint: check.command },
          ...check.args.map((arg, index) => ({
            value: `arg:${index}`,
            label: `Аргумент ${index + 1}`,
            hint: JSON.stringify(arg),
          })),
          ...(check.args.length < 100 ? [{ value: 'add', label: 'Добавить аргумент' }] : []),
          ...(check.args.length ? [{ value: 'remove', label: 'Удалить аргумент' }] : []),
          { value: 'back', label: '← К проверкам' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'title' || choice === 'command')
      await projectField(
        choice === 'title' ? 'Название проверки' : 'Программа без аргументов',
        check[choice],
        async (value) => update({ ...check, [choice]: value }),
        { limit: choice === 'title' ? 500 : 4096 },
      );
    if (choice === 'add') await update({ ...check, args: [...check.args, ''] });
    if (choice.startsWith('arg:')) {
      const index = Number(choice.slice(4));
      await projectField(
        `Аргумент ${index + 1} · буквальный текст`,
        check.args[index] ?? '',
        async (value) => {
          const args = [...check.args];
          args[index] = value;
          await update({ ...check, args });
        },
        { limit: 16000, allowEmpty: true },
      );
    }
    if (choice === 'remove')
      await projectChoice(
        'Какой аргумент удалить?',
        check.args.map((arg, index) => ({
          value: String(index),
          label: `${index + 1}. ${JSON.stringify(arg)}`,
        })),
        async (index) =>
          update({
            ...check,
            args: check.args.filter((_, position) => position !== Number(index)),
          }),
      );
  }
}

/** Проверки остаются частью черновика; редактор не запускает ни одной команды. */
export async function editStageVerification(
  initial: Verification,
  save: (value: Verification) => Promise<void>,
): Promise<void> {
  let verification = structuredClone(initial);
  const update = async (next: Verification) => {
    verification = next;
    await save(next);
  };
  while (true) {
    const current = verification;
    const choice = await liveSelect({
      title: 'Проверка результата этапа',
      load: async () => ({
        summary:
          current.kind === 'manual'
            ? current.instructions
            : 'Команды выполняются после принятия плана.',
        message: current.kind === 'manual' ? 'Ручная проверка' : 'Автоматические проверки',
        options: [
          ...(current.kind === 'manual'
            ? [{ value: 'instructions', label: 'Что проверить человеку' }]
            : current.checks.map((check) => ({
                value: `check:${check.id}`,
                label: check.title,
                hint: check.command,
              }))),
          ...(current.kind === 'commands' && current.checks.length < 16
            ? [{ value: 'add', label: 'Добавить команду' }]
            : []),
          ...(current.kind === 'commands' && current.checks.length > 1
            ? [{ value: 'remove', label: 'Удалить проверку' }]
            : []),
          {
            value: 'switch',
            label: current.kind === 'manual' ? 'Использовать команды' : 'Проверять вручную',
          },
          { value: 'back', label: '← К этапу' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === 'back') return;
    if (choice === 'switch')
      await update(
        current.kind === 'manual'
          ? {
              kind: 'commands',
              checks: [{ id: id(), title: 'Новая проверка', command: '', args: [] }],
            }
          : { kind: 'manual', instructions: 'Проверьте ожидаемый результат этапа.' },
      );
    if (choice === 'instructions' && current.kind === 'manual')
      await projectField(
        'Как проверить результат?',
        current.instructions,
        async (instructions) => update({ kind: 'manual', instructions }),
        { limit: 8000 },
      );
    if (current.kind !== 'commands') continue;
    if (choice === 'add')
      await update({
        ...current,
        checks: [...current.checks, { id: id(), title: 'Новая проверка', command: '', args: [] }],
      });
    if (choice === 'remove')
      await projectChoice(
        'Какую проверку удалить?',
        current.checks.map((check) => ({ value: check.id, label: check.title })),
        async (checkId) =>
          update({ ...current, checks: current.checks.filter((check) => check.id !== checkId) }),
      );
    if (choice.startsWith('check:')) {
      const check = current.checks.find((item) => item.id === choice.slice(6));
      if (check)
        await editCommand(check, async (next) => {
          if (verification.kind === 'commands')
            await update({
              ...verification,
              checks: verification.checks.map((item) => (item.id === next.id ? next : item)),
            });
        });
    }
  }
}
