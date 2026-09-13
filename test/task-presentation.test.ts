import { expect, it } from 'vitest';
import { toolSummary } from '../src/interfaces/tool-summary.js';
import { TaskFeed } from '../src/interfaces/guided/task-feed.js';
import { taskFrame } from '../src/interfaces/guided/task-screen.js';
import { workspaceLine } from '../src/interfaces/guided/task-layout.js';
import { taskEvent } from '../src/interfaces/task-events.js';
import { terminalText } from '../src/interfaces/guided/screen.js';
import type { TaskView } from '../src/interfaces/types.js';
import type { ToolInvocation } from '../src/sessions/types.js';
import stringWidth from 'string-width';
import { harness, ScriptedProvider, output, call } from './helpers.js';

function invocation(
  tool: string,
  result: unknown,
  status: ToolInvocation['status'] = 'succeeded',
): ToolInvocation {
  return {
    id: 'tool-1',
    agentId: 'root',
    call: call('call-1', tool, { path: '.', command: 'node' }),
    effect: 'read',
    status,
    startedAt: '2026-09-12T04:00:00Z',
    result: JSON.stringify(result),
  };
}
function status(): TaskView {
  return {
    runId: '266ef821-702e-45d7-bda7-7743f6274408',
    task: 'Изучи файлы проекта bro-prokat',
    workspace: '/Users/long-name/Documents/ChatGPT/harness',
    status: 'cancelled',
    sessionId: 'session',
    profile: 'codex',
    turns: 5,
    learningVersion: 'baseline',
    usage: { input: 0, output: 0 },
    cursor: 0,
    events: [],
    approvals: [],
    agents: [],
    unknownInvocations: [],
    output: { events: [], cursor: 0, hasMore: false },
  };
}

it('каталог отображается именами и счётчиками без сырого JSON, количество скрытых записей честное', () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({
    name: 'entry-' + i,
    directory: i < 3,
    symlink: i === 9,
  }));
  const summary = toolSummary(invocation('fs.list', entries));
  expect(summary.title).toBe('Просмотр папки · готово');
  expect(summary.detail).toContain('Найдено: папок 3, файлов 6, ссылок 1.');
  expect(summary.detail).toContain('entry-0/');
  expect(summary.detail).toContain('… ещё 5');
  expect(summary.detail).not.toContain('"directory"');
  expect(summary.detail).not.toContain('entry-9');
  expect(toolSummary(invocation('fs.list', [])).detail).toContain('папок 0, файлов 0');
});

it('страница каталога показывает полный размер папки и наличие следующих записей', () => {
  const detail = toolSummary(
    invocation('fs.list', {
      entries: [{ name: 'readme', directory: false, symlink: false }],
      total: 501,
      offset: 0,
      nextOffset: 1,
    }),
  ).detail;
  expect(detail).toContain('Показано записей: 1 из 501.');
  expect(detail).toContain('Есть ещё записи в папке.');
  expect(detail).not.toContain('сохранён отдельно');
});

it.each([
  ['file_limit', 'предел файлов'],
  ['directory_limit', 'предел папок'],
  ['match_limit', 'другие совпадения'],
  ['unreadable', 'не удалось прочитать'],
])('неполный поиск %s показывает причину без ложного обещания артефакта', (reason, message) => {
  const detail = toolSummary(
    invocation('fs.search', {
      matches: [],
      visited: 1000,
      incomplete: true,
      reason,
    }),
  ).detail;
  expect(detail).toContain('Поиск неполный.');
  expect(detail).toContain(message);
  expect(detail).not.toContain('сохранён отдельно');
});

it('полный поиск без совпадений не получает предупреждение о неполноте', () => {
  const detail = toolSummary(
    invocation('fs.search', {
      matches: [],
      visited: 2,
      incomplete: false,
      reason: null,
    }),
  ).detail;
  expect(detail).toContain('Совпадений: 0 · проверено файлов: 2.');
  expect(detail).not.toContain('неполный');
});

it('чтение файла не выводит содержимое в журнал, команды сохраняют код выхода и причину ошибки', () => {
  expect(
    toolSummary(invocation('fs.read', { content: 'private-content', totalCharacters: 50 })).detail,
  ).toContain('Прочитано символов: 15 из 50.');
  expect(
    toolSummary(invocation('fs.read', { content: 'private-content', totalCharacters: 50 })).detail,
  ).not.toContain('private-content');
  const program = toolSummary(
    invocation('process.exec', { exitCode: 2, stdout: '', stderr: 'Неправильный аргумент' }),
  );
  expect(program.detail).toContain('Код выхода: 2');
  expect(program.detail).toContain('Неправильный аргумент');
  const denied = toolSummary(invocation('fs.write', { error: 'Нет разрешения' }, 'denied'));
  expect(denied.title).toContain('запрещено');
  expect(denied.detail).toContain('Нет разрешения');
});

it('неизвестный или неполный результат не превращается в обрезанный JSON в интерфейсе', () => {
  const malformed = { ...invocation('mcp.remote', {}), result: '{"broken":' };
  expect(toolSummary(malformed).detail).toContain('Результат сохранён');
  expect(toolSummary(malformed).detail).not.toContain('broken');
  expect(
    toolSummary(invocation('fs.list', { truncated: true, artifactId: 'artifact' })).detail,
  ).toContain('сохранён отдельно: artifact');
});

it.each([false, true])('потеря хвоста stdout/stderr видна и при artifact=%s', (artifact) => {
  const result = artifact
    ? { truncated: true, artifactId: 'output', stdoutTruncated: true, stderrTruncated: true }
    : { exitCode: 0, stdout: 'Начало', stderr: '', stdoutTruncated: true, stderrTruncated: true };
  const detail = toolSummary(invocation('process.exec', result)).detail;
  expect(detail).toContain('Вывод команды обрезан: конец не сохранён.');
  expect(detail).toContain('Вывод ошибок обрезан: конец не сохранён.');
  if (artifact) expect(detail).toContain('сохранён отдельно: output');
  else expect(detail).toContain('Код выхода: 0');
});

it('обычный большой результат команды не объявляется потерянным хвостом', () => {
  const detail = toolSummary(
    invocation('process.exec', { truncated: true, artifactId: 'output' }),
  ).detail;
  expect(detail).toContain('сохранён отдельно: output');
  expect(detail).not.toContain('конец не сохранён');
});

it('ошибка команды не скрывает предупреждение об обрезанном потоке', () => {
  const detail = toolSummary(
    invocation(
      'process.exec',
      {
        truncated: true,
        artifactId: 'failed-output',
        stderrTruncated: true,
      },
      'error',
    ),
  ).detail;
  expect(detail).toContain('Вывод ошибок обрезан: конец не сохранён.');
});

it.each([48, 90])(
  'экран %i колонок показывает автора, правильную папку и отсутствие ответа после отмены',
  (width) => {
    const feed = new TaskFeed();
    feed.update(status());
    for (const tab of ['text', 'reasoning', 'all'] as const) {
      const frame = terminalText(taskFrame(feed, width, 24, tab, 0));
      expect(frame).toContain('Harness by Ghost_Raven');
      expect(frame).toContain('Папка:');
      expect(frame).toContain('harness');
      expect(frame).not.toContain('Ожидаю новые события');
      expect(frame).not.toContain('Ctrl+C — остановить');
      expect(frame).toContain('Enter — действия');
      expect(frame.split('\n').length).toBeLessThan(24);
      expect(frame.split('\n').every((line) => line.length < width)).toBe(true);
    }
    expect(taskFrame(feed, width, 24, 'text', 0)).toContain('Итогового ответа нет.');
  },
);

it.each(['/Users/long-name/Documents/ChatGPT/harness', 'C:\\Users\\Long Name\\Documents\\harness'])(
  'длинный путь %s не прячет имя проекта',
  (path) => {
    expect(workspaceLine(path, 48)).toMatch(/^Папка: .*harness$/);
    expect(workspaceLine(path, 48).length).toBeLessThan(48);
  },
);

it('проекция сохранённого журнала меняет только представление результата инструмента', async () => {
  const provider = new ScriptedProvider((_, i) =>
    i === 0 ? output('', [call('list', 'fs.list', { path: '.' })]) : output('Готово'),
  );
  const app = await harness(provider);
  const { runId } = await app.runtime.start({
    message: 'Покажи файлы',
    workspace: app.workspace,
    requestKey: 'presentation',
  });
  await app.runtime.wait(runId);
  const original = app.sessions.history(runId, 0).find((event) => event.type === 'tool.succeeded')!;
  const saved = structuredClone(original);
  const projected = taskEvent(original);
  expect(projected.title).toBe('Просмотр папки · готово');
  expect(projected.detail).toContain('Найдено:');
  expect(original).toEqual(saved);
  const feed = new TaskFeed();
  feed.update({ ...status(), events: [{ ...projected, detail: projected.detail + '\x1b[2J' }] });
  const frame = terminalText(taskFrame(feed, 90, 24, 'log', 0));
  expect(frame).toContain('Найдено:');
  expect(frame).not.toContain('"directory"');
  expect(feed.items('log')[0]?.text).not.toContain('\x1b');
});

it.each([
  [48, 24],
  [90, 30],
  [120, 40],
])('экран %i×%i отделяет задачу, события и управление даже без цвета', (width, height) => {
  const feed = new TaskFeed();
  feed.update({
    ...status(),
    events: [
      {
        seq: 1,
        type: 'tool.succeeded',
        payload: {},
        title: 'Просмотр папки · готово',
        role: 'coordinator',
        at: '2026-09-12T04:41:19Z',
        detail: 'Папка: текущая\n' + Array.from({ length: 60 }, (_, i) => 'Файл ' + i).join('\n'),
      },
    ],
  });
  const frame = terminalText(taskFrame(feed, width!, height!, 'all', 0));
  const rows = frame.split('\n');
  expect(frame).toMatch(/╭─ Задача 266ef821/);
  expect(frame).toMatch(/╭─ Ход задачи/);
  expect(frame).toMatch(/── Управление/);
  expect(frame).toContain('[Все]');
  expect(frame).toContain('Просмотр папки · готово');
  expect(frame).toContain('продолжение');
  expect(frame).toContain('04:41:19 · coordinator');
  expect(frame).toContain('Файл 59');
  expect(frame.indexOf('Папка:')).toBeLessThan(frame.indexOf('╭─ Ход задачи'));
  expect(rows.length).toBeLessThan(height!);
  expect(rows.every((row) => stringWidth(row) < width!)).toBe(true);
  const edges = rows
    .filter((row) => row.trimStart().startsWith('│'))
    .map((row) => stringWidth(row));
  expect(new Set(edges).size).toBe(1);
});

it('широкие Unicode-символы и длинный путь не ломают рамки и кнопки', () => {
  const feed = new TaskFeed();
  feed.update({
    ...status(),
    task: 'Исследуй 東京 📚'.repeat(10),
    workspace: '/Projects/東京/研究',
    result: 'Проверка 日本語 👩‍💻 '.repeat(70),
  });
  const frame = terminalText(taskFrame(feed, 48, 24, 'text', 0));
  expect(frame.split('\n').every((row) => stringWidth(row) < 48)).toBe(true);
  expect(frame).toContain('Исследуй');
  expect(frame).toContain('Последний ответ модели');
  expect(frame).toContain('Enter — действия');
});
