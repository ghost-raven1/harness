import type { ModelOutput, ModelProvider, ModelRequest, ToolCall } from './types.js';

export const demoGoal = 'Исправить расчёт стоимости: цена 120 × количество 3 должны дать 360.';
export const demoTitle = 'Учебная корзина';
export const demoSource = 'export const total = (price, quantity) => price + quantity;\n';
export const demoIncorrect = 'export const total = (price, quantity) => price * quantity - 1;\n';
export const demoCorrect = 'export const total = (price, quantity) => price * quantity;\n';

/** Учебные ответы опираются на сохранённые сообщения; сеть и скрытый счётчик не используются. */
export class DemoProvider implements ModelProvider {
  /** Возвращает один шаг фиксированного сценария через обычный контракт модели. */
  async generate(request: ModelRequest): Promise<ModelOutput> {
    request.signal?.throwIfAborted();
    const planning = request.messages[0]?.content.includes('PROJECT PLANNING:') === true;
    const history = request.messages.filter(
      (item) => !item.content.startsWith('[HARNESS REMINDER,'),
    );
    let lastTask = history.length - 1;
    while (lastTask >= 0 && history[lastTask]?.role !== 'user') lastTask--;
    const task = history[lastTask]?.content ?? '';
    if (!task.includes(demoGoal))
      return this.answer(
        'Учебный режим выполняет только сценарий «Учебная корзина». Для собственной задачи выйдите из демо и выберите обычный проект.',
      );
    const calls = history.slice(lastTask + 1).flatMap((item) => item.toolCalls ?? []);
    const sequence = history.flatMap((item) => item.toolCalls ?? []).length;
    for (const call of calls) {
      const result = history
        .slice(lastTask + 1)
        .find((item) => item.role === 'tool' && item.toolCallId === call.id);
      if (!result)
        return this.answer(
          'Результат учебной операции не подтверждён. Проверьте журнал задачи перед продолжением.',
        );
      try {
        const value: unknown = JSON.parse(result.content);
        if (
          value &&
          typeof value === 'object' &&
          ('error' in value || ('isError' in value && value.isError === true))
        )
          return this.answer(
            'Учебная операция завершилась ошибкой. Откройте журнал; завершение записи не подтверждено.',
          );
      } catch {
        // Старые текстовые результаты остаются допустимыми; ошибок в них не угадываем.
      }
    }
    if (!calls.some((call) => call.name === 'fs.read'))
      return this.answer('Открою исходный расчёт стоимости.', [
        {
          id: 'demo-read-' + sequence,
          name: 'fs.read',
          arguments: JSON.stringify({ path: 'price.js' }),
        },
      ]);
    if (planning)
      return this.answer(
        JSON.stringify({
          stages: [
            {
              id: 'price',
              title: 'Исправить стоимость корзины',
              role: 'coordinator',
              task: demoGoal,
              dependsOn: [],
              expectedResult:
                'total(120, 3) возвращает 360; исходный тест проходит без изменения ожиданий.',
              requiredTools: ['fs.read', 'fs.write'],
              verification: {
                kind: 'commands',
                checks: [
                  {
                    id: 'price-test',
                    title: 'Расчёт стоимости: 120 × 3 = 360',
                    command: process.execPath,
                    args: ['--test', 'price.test.js'],
                  },
                ],
              },
            },
          ],
          maxCorrections: 2,
          fixBaselineFailures: true,
        }),
      );
    if (!calls.some((call) => call.name === 'fs.write')) {
      const correction = task.includes('Обязательная проверка не прошла');
      return this.answer(
        correction
          ? 'Тест обнаружил ошибку. Исправлю формулу, сохранив исходное ожидание 360.'
          : 'Первая учебная попытка намеренно содержит ошибку: проверка должна её обнаружить.',
        [
          {
            id: 'demo-write-' + sequence,
            name: 'fs.write',
            arguments: JSON.stringify({
              path: 'price.js',
              content: correction ? demoCorrect : demoIncorrect,
            }),
          },
        ],
      );
    }
    return this.answer(
      'Изменение записано. Harness проверит его сохранённой командой; окончательный результат принимает человек.',
    );
  }

  /** Упаковывает текст и структурированные вызовы так же, как сетевой адаптер. */
  private answer(text: string, calls: ToolCall[] = []): ModelOutput {
    return { text, calls, finish: calls.length ? 'tools' : 'stop', usage: { input: 0, output: 0 } };
  }
}
