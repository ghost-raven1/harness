import { message } from '../../shared/primitives.js';
import { applicationErrorData } from '../../shared/application-error.js';
import { ZodError } from 'zod';

/** Контекст настройки позволяет объяснить JSON-ошибку, не раскрывая содержимое файла. */
export function explainError(error: unknown, context?: 'configuration'): string {
  const text = message(error);
  const code = applicationErrorData(error)?.code;
  const explanations = {
    TASK_BUSY: 'Задача ещё работает или останавливается. Дождитесь остановки и повторите действие.',
    STALE_PREVIEW:
      'Данные изменились после просмотра. Откройте предпросмотр ещё раз и подтвердите актуальный состав.',
    UNKNOWN_OUTCOME:
      'Результат операции неизвестен. Откройте технические подробности задачи и подтвердите результат проверки.',
    STORAGE_UNAVAILABLE:
      'Не удалось сохранить данные. Проверьте свободное место и доступ к диску; затем запустите проверку истории в doctor.',
    INCOMPATIBLE_PROTOCOL:
      'CLI и сервис используют разные версии протокола. Завершите задачи и откройте CLI из той же установки Harness.',
    INVALID_REQUEST:
      'Команда не соответствует версии сервиса. Проверьте параметры команды и версии CLI и сервиса.',
    INVALID_RESPONSE:
      'Сервис вернул неполный или несовместимый ответ. Проверьте состояние задачи перед повтором действия и запустите doctor.',
    UNKNOWN_COMMAND:
      'Сервис не поддерживает эту команду. Проверьте версии CLI и запущенного сервиса.',
  };
  if (code && !(context === 'configuration' && error instanceof ZodError))
    return explanations[code];
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
