import { readTaskInput } from '../task-input.js';
import { liveSelect } from '../live-select.js';

/** Поле сохраняется во время ввода; Escape оставляет последний сохранённый черновик. */
export async function projectField(
  message: string,
  value: string,
  save: (value: string) => Promise<void>,
  options: { limit?: number; allowEmpty?: boolean; refresh?: () => Promise<unknown> } = {},
): Promise<void> {
  await readTaskInput({
    message,
    initialValue: value,
    allowEmpty: options.allowEmpty,
    submitLabel: 'сохранить',
    description: () => 'Ctrl+S — закончить ввод · Esc — сохранить и вернуться',
    save: async (text) => {
      if (text.length > (options.limit ?? 32000)) throw new Error('Поле слишком длинное.');
      await save(text);
    },
    refresh: options.refresh,
  });
}

/** Переключает один пункт множества без потери уже выбранных значений. */
export async function chooseProjectSet(
  title: string,
  choices: Array<{ value: string; label: string }>,
  current: string[],
  save: (values: string[]) => Promise<void>,
): Promise<void> {
  let values = [...current];
  while (true) {
    const choice = await liveSelect({
      title,
      load: async () => ({
        summary: 'Enter — включить или исключить пункт. Изменения сохраняются в черновике.',
        message: 'Выберите нужные пункты',
        options: [
          ...choices.map((item) => ({
            ...item,
            label: (values.includes(item.value) ? '✓ ' : '○ ') + item.label,
          })),
          ...values
            .filter((value) => !choices.some((item) => item.value === value))
            .map((value) => ({
              value,
              label: '✓ Недоступно или удалено: ' + value,
              hint: 'Enter — убрать из выбранных',
            })),
          { value: '__done', label: 'Готово · назад к этапу' },
        ],
      }),
    });
    if (typeof choice === 'symbol' || choice === '__done') return;
    values = values.includes(choice)
      ? values.filter((value) => value !== choice)
      : [...values, choice];
    await save(values);
  }
}

/** Выбирает значение из закреплённой конфигурации без изменения глобальных настроек. */
export async function projectChoice(
  title: string,
  choices: Array<{ value: string; label: string }>,
  save: (value: string) => Promise<void>,
): Promise<void> {
  const value = await liveSelect({
    title,
    load: async () => ({ message: title, options: choices }),
  });
  if (typeof value === 'symbol') return;
  await save(value);
}
