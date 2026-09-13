import { message } from '../../shared/primitives.js';
import { ZodError } from 'zod';

/** Контекст настройки позволяет объяснить JSON-ошибку, не раскрывая содержимое файла. */
export function explainError(error: unknown, context?: 'configuration'): string {
  const text = message(error);
  if (context === 'configuration') {
    if (
      error instanceof SyntaxError ||
      /Unexpected.*JSON|not valid JSON|end of JSON input/i.test(text)
    )
      return 'В файле настроек ошибка JSON. Исправьте файл и нажмите «Попробовать снова» или выберите «Настроить заново».';
    if (error instanceof ZodError)
      return 'Структура настроек не подходит Harness. Проверьте поля по примеру в папке config или выберите «Настроить заново».';
  }
  if (/HTTP 401|HTTP 403|Missing API key/i.test(text))
    return 'Сервис модели не принял ключ или доступ к модели. Откройте «Настройки → Ключ API», проверьте ключ и выбранную модель.';
  if (/HTTP 429/i.test(text))
    return 'Провайдер временно ограничил запросы. Подождите и продолжите сохранённую задачу через «Мои задачи». Если ограничение сохраняется, проверьте лимиты и баланс аккаунта.';
  if (/HTTP 404/i.test(text))
    return 'Модель или адрес API не найдены. Проверьте выбор модели в настройках подключения.';
  if (/timed out|timeout|fetch failed|Provider adapter failed/i.test(text))
    return 'Нет ответа от модели. Проверьте интернет или запущенный локальный сервер. Сохранённые задачи доступны в «Моих задачах».';
  if (/Local service unavailable/i.test(text))
    return 'Сервис остановлен. Закройте это окно и снова откройте «Запустить Harness».';
  if (/CONTEXT_LIMIT/i.test(text))
    return 'Задача не помещается в контекст модели. Начните новую задачу с меньшим количеством файлов или выберите модель с большим контекстом.';
  if (/ENOENT|ENOTDIR|Workspace must be/i.test(text))
    return 'Папка или файл больше недоступны. Проверьте подключение диска и выберите существующую папку в настройках.';
  if (/EACCES|EPERM/i.test(text))
    return 'Приложению недоступна выбранная папка. Выберите папку, к которой у вашей учётной записи есть доступ.';
  return text;
}
