import { expect, it } from 'vitest';
import stringWidth from 'string-width';
import { taskSummary } from '../src/interfaces/guided/task-summary.js';
import { menuFrame } from '../src/interfaces/guided/live-select.js';
import { terminalText } from '../src/interfaces/guided/screen.js';
import type { StatusView } from '../src/interfaces/types.js';

function task(overrides: Partial<StatusView> = {}): StatusView {
  return {
    runId: 'run',
    sessionId: 'session',
    task: 'Проверь ключи в админке',
    workspace: '/Users/alexey/Downloads/bro-prokat',
    status: 'completed',
    profile: 'codex',
    turns: 1,
    learningVersion: 'baseline',
    usage: { input: 100, output: 50 },
    cursor: 0,
    events: [],
    approvals: [],
    agents: [],
    unknownInvocations: [],
    ...overrides,
  };
}

it.each([48, 80, 200])(
  '%i колонок: короткий ответ сохраняет абзацы и полностью помещается в карточку',
  (columns) => {
    const result = 'Проверяем настройки Studio?\n\nУточните раздел админки.';
    const summary = taskSummary(task({ result }), columns, 24);
    expect(summary).toContain('\nОтвет получен\n\n' + result);
    expect(summary).not.toContain('Полный ответ');
    expect(summary).not.toContain('Уточните раздел админки.…');
    expect(
      summary.split('\n').every((line) => stringWidth(line) <= Math.min(columns - 5, 104)),
    ).toBe(true);
    const frame = terminalText(
      menuFrame(
        'Задача',
        {
          summary,
          summaryRows: 12,
          message: 'Что дальше?',
          options: [{ value: 'answer', label: 'Прочитать ответ' }],
        },
        'answer',
        columns - 1,
        24,
      ),
    );
    expect(frame).toContain('Уточните раздел админки.');
    expect(frame).toContain('Enter — открыть');
    expect(frame.split('\n').length).toBeLessThan(24);
    expect(frame.split('\n').every((line) => stringWidth(line) <= Math.min(columns - 1, 108))).toBe(
      true,
    );
  },
);

it.each([48, 80, 200])(
  '%i колонок: длинные название и ответ не скрывают состояние и переход к полному тексту',
  (columns) => {
    const summary = taskSummary(
      task({
        task: 'Проверь ключи во всех разделах админки и их применение на сайте. '.repeat(40),
        result: 'Уточните, какие настройки нужно проверить. '.repeat(100),
      }),
      columns,
      24,
    );
    expect(summary.split('\n').length).toBeLessThanOrEqual(10);
    expect(summary).toContain('bro-prokat');
    expect(summary).toContain('Ответ получен');
    expect(summary).toContain('Уточните, какие настройки');
    expect(summary).toContain('Полный ответ — «Прочитать ответ»');
    expect(
      summary.split('\n').every((line) => stringWidth(line) <= Math.min(columns - 5, 104)),
    ).toBe(true);
  },
);

it('разметка ответа, шаблоны путей и команды остаются неизменными; управляющие коды удаляются', () => {
  const result = '**Ключи Studio**\n\n```sh\nrg "**" src/**/*.ts\n```';
  const current = task({ result: '\u001b[2J' + result });
  expect(taskSummary(current, 200, 32)).toContain(result);
  expect(taskSummary(current, 200, 32)).not.toContain('\u001b');
  expect(current.result).toBe('\u001b[2J' + result);
});

it.each([48, 80, 200])(
  '%i колонок: emoji, CJK и комбинируемые символы не ломают границы',
  (columns) => {
    const summary = taskSummary(
      task({
        task: 'Проверка 設定 🤝 и Cafe\u0301',
        workspace: '/Users/作業/🧰-проект',
        result: 'Настройки 設定 🤝 Cafe\u0301 найдены. '.repeat(30),
      }),
      columns,
      24,
    );
    expect(summary).toContain('設定');
    expect(summary).toContain('🤝');
    expect(summary).not.toContain('\ufffd');
    expect(
      summary.split('\n').every((line) => stringWidth(line) <= Math.min(columns - 5, 104)),
    ).toBe(true);
  },
);

it('ошибка и необходимость проверить прерванную операцию видны до превью ответа', () => {
  const summary = taskSummary(
    task({
      status: 'paused',
      deletedAt: '2026-09-12T00:00:00Z',
      unknownInvocations: [{ id: 'write', tool: 'fs.write' }],
      error: 'Неизвестен результат записи файла. '.repeat(20),
      result: 'Предварительный ответ '.repeat(100),
    }),
    48,
    24,
  );
  expect(summary).toContain('Приостановлено');
  expect(summary).toContain('нужна проверка операции');
  expect(summary).toContain('Неизвестен результат записи файла.');
  expect(summary.split('\n').length).toBeLessThanOrEqual(10);
});

it.each([48, 80])(
  '%i колонок: сообщение о сохранении не вытесняется длинным ответом',
  (columns) => {
    const summary = taskSummary(
      task({ result: 'Предварительный ответ '.repeat(100) }),
      columns,
      24,
      'Ответ сохранён: /Users/alexey/Downloads/bro-prokat/Ответ Harness.md',
    );
    expect(summary).toContain('Ответ сохранён:');
    expect(summary).toContain('Ответ получен');
    expect(summary).toContain('Полный ответ — «Прочитать ответ»');
    expect(summary.split('\n').length).toBeLessThanOrEqual(10);
  },
);

it.each([14, 16, 18, 20])('при высоте %i строк карточка оставляет место для действий', (rows) => {
  const summary = taskSummary(
    task({
      status: 'failed',
      task: 'Длинная задача '.repeat(100),
      error: 'Ошибка подключения к модели. '.repeat(50),
      result: 'Сохранённый ответ '.repeat(100),
    }),
    48,
    rows,
  );
  expect(summary ? summary.split('\n').length : 0).toBeLessThanOrEqual(Math.max(0, rows - 14));
  if (rows > 14) expect(summary).toContain('Ошибка');
});
