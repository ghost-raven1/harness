import type { DiagnosticStatus } from '../../diagnostics/types.js';
import type { CliContext } from '../types.js';
import { liveSelect } from './live-select.js';
import { readText } from './text-reader.js';
import { terminalText } from './screen.js';

/** Объясняет содержимое и ротацию диагностического файла по актуальному состоянию. */
function details(status: DiagnosticStatus): string {
  return [
    status.enabled ? 'Запись включена.' : 'Запись выключена.',
    '\nФайл: ' + status.file,
    '\nСохраняются время, имена команд, длительность, исходы задач и безопасные коды ошибок.',
    'Тексты задач, ответы, аргументы инструментов, ключи и вывод внешних программ не записываются.',
    '\nХранится до ' +
      status.retainedFiles +
      ' файлов по ' +
      Math.round(status.maxBytes / 1024) +
      ' КиБ. Старые записи заменяются.',
    'Выключение останавливает запись. Созданные файлы остаются на диске.',
    ...(status.error ? ['\n' + status.error] : []),
  ].join('\n');
}

/** Переключатель относится к сервису и виден всем подключённым окнам. */
export async function showDiagnostics(context: CliContext): Promise<void> {
  while (true) {
    const action = await liveSelect({
      title: 'Диагностический лог',
      load: async () => {
        const status = await context.request('diagnostics.status');
        return {
          summaryTitle: 'Запись в файл',
          summary: [
            status.enabled ? 'Включена' : 'Выключена',
            'Файл: ' + terminalText(status.file),
            'Команды, исходы задач, длительность и коды ошибок.',
            'Без текстов задач, ответов и ключей.',
            ...(status.error ? [status.error] : []),
          ].join('\n'),
          message: 'Что сделать?',
          options: [
            {
              value: status.enabled ? 'disable' : 'enable',
              label: status.enabled ? 'Выключить запись в файл' : 'Включить запись в файл',
            },
            { value: 'details', label: 'Где хранится лог и что записывается' },
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    });
    if (typeof action === 'symbol' || action === 'back') return;
    if (action === 'enable' || action === 'disable')
      await context.request('diagnostics.configure', { enabled: action === 'enable' });
    if (action === 'details') {
      const load = async () => {
        const status = await context.request('diagnostics.status');
        return { tabs: [{ id: 'log', label: 'Диагностика', text: details(status) }] };
      };
      await readText('Диагностический лог', (await load()).tabs, { load });
    }
  }
}
