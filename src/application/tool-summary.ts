import type { ToolInvocation } from '../sessions/types.js';

/** Приводит неизвестное значение к объекту для безопасного предпросмотра. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** Разбирает JSON результата, не прерывая интерфейс из-за обычного текста. */
function parse(value?: string): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(value);
  } catch {
    return undefined;
  }
}
/** Готовит однострочный предпросмотр текста или числа заданной длины. */
function short(value: unknown, limit = 150): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}
/** Подсчитывает типы записей и показывает первые имена в читаемом виде. */
function directorySummary(entries: unknown[]): string {
  const rows = entries.map(object);
  const folders = rows.filter((row) => row.directory === true && row.symlink !== true);
  const links = rows.filter((row) => row.symlink === true);
  const files = rows.filter((row) => row.directory !== true && row.symlink !== true);
  const names = rows
    .slice(0, 5)
    .map(
      (row) => short(row.name, 40) + (row.directory ? '/' : '') + (row.symlink ? ' → ссылка' : ''),
    );
  return [
    `Найдено: папок ${folders.length}, файлов ${files.length}` +
      (links.length ? `, ссылок ${links.length}` : '') +
      '.',
    ...names.map((name) => '  ' + name),
    ...(rows.length > names.length ? ['  … ещё ' + (rows.length - names.length)] : []),
  ].join('\n');
}

/** Краткое описание для человека; исходные аргументы и результаты остаются в журнале запуска. */
export function toolSummary(invocation: ToolInvocation): { title: string; detail: string } {
  const args = object(parse(invocation.call.arguments));
  const value = parse(invocation.result),
    result = object(value);
  const tool = invocation.call.name;
  const names: Record<string, string> = {
    'fs.list': 'Просмотр папки',
    'fs.read': 'Чтение файла',
    'fs.write': 'Запись файла',
    'fs.search': 'Поиск по файлам',
    'process.exec': 'Запуск программы',
    'artifacts.read': 'Чтение сохранённого результата',
  };
  const states: Record<ToolInvocation['status'], string> = {
    started: 'выполняется',
    succeeded: 'готово',
    error: 'ошибка',
    denied: 'запрещено',
    cancelled: 'отменено',
    unknown: 'результат неизвестен',
  };
  const title = (names[tool] ?? tool) + ' · ' + states[invocation.status];
  const path = short(args.path ?? args.command ?? args.id, 240);
  const target = path
    ? (tool === 'fs.list'
        ? 'Папка: '
        : ['fs.read', 'fs.write'].includes(tool)
          ? 'Файл: '
          : tool === 'process.exec'
            ? 'Программа: '
            : 'Путь: ') + (tool === 'fs.list' && path === '.' ? 'текущая' : path)
    : '';
  const outputWarnings =
    tool === 'process.exec'
      ? [
          ...(result.stdoutTruncated === true ? ['Вывод команды обрезан: конец не сохранён.'] : []),
          ...(result.stderrTruncated === true ? ['Вывод ошибок обрезан: конец не сохранён.'] : []),
        ]
      : [];
  let summary = '';
  if (invocation.status !== 'started') {
    if (result.error || invocation.error) summary = short(result.error ?? invocation.error, 350);
    else if (invocation.status !== 'succeeded')
      summary = short(
        typeof value === 'string' ? value : 'Подробности сохранены в журнале запуска.',
      );
    else if (result.truncated === true)
      summary =
        'Большой результат сохранён отдельно' +
        (result.artifactId ? ': ' + short(result.artifactId) : '') +
        '.';
    else if (tool === 'fs.list' && Array.isArray(value)) summary = directorySummary(value);
    else if (tool === 'fs.list' && Array.isArray(result.entries))
      summary = [
        directorySummary(result.entries),
        'Показано записей: ' + result.entries.length + ' из ' + result.total + '.',
        ...(typeof result.nextOffset === 'number' ? ['Есть ещё записи в папке.'] : []),
      ].join('\n');
    else if (tool === 'fs.read' && typeof result.content === 'string')
      summary =
        'Прочитано символов: ' +
        result.content.length +
        (typeof result.totalCharacters === 'number' ? ' из ' + result.totalCharacters : '') +
        '.';
    else if (tool === 'fs.search' && Array.isArray(result.matches)) {
      summary =
        'Совпадений: ' +
        result.matches.length +
        (typeof result.visited === 'number' ? ' · проверено файлов: ' + result.visited : '') +
        '.';
      if (result.incomplete === true) {
        const reasons: Record<string, string> = {
          file_limit: 'Достигнут предел файлов. Укажите более узкую папку.',
          directory_limit: 'Достигнут предел папок. Укажите более узкую папку.',
          match_limit: 'Есть другие совпадения. Уточните текст или папку.',
          unreadable: 'Часть файлов или папок не удалось прочитать. Проверьте доступ.',
        };
        summary +=
          '\nПоиск неполный. ' + (reasons[String(result.reason)] ?? 'Просмотрена часть файлов.');
      }
    } else if (tool === 'fs.write' && typeof result.bytes === 'number')
      summary = 'Записано байт: ' + result.bytes + '.';
    else if (tool === 'process.exec')
      summary = [
        'Код выхода: ' + (typeof result.exitCode === 'number' ? result.exitCode : 'не получен'),
        ...(result.signal ? ['Сигнал: ' + short(result.signal)] : []),
        ...(result.stdout ? [short(result.stdout, 180)] : []),
        ...(result.stderr ? ['Ошибка: ' + short(result.stderr, 180)] : []),
      ].join('\n');
    else if (typeof value === 'string') summary = short(value, 300);
    else summary = 'Результат сохранён в журнале запуска.';
  }
  return { title, detail: [target, ...outputWarnings, summary].filter(Boolean).join('\n') };
}
