import { readText } from './text-reader.js';

/** Убирает старые данные перед возвратом в каталог после удаления другим клиентом. */
export async function showRemovedTask(): Promise<void> {
  await readText('Задача удалена', [
    {
      id: 'removed',
      label: 'Задача',
      text: 'Задача удалена в другом окне. Esc — к списку задач.',
    },
  ]);
}
