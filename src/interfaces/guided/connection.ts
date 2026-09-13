import * as prompts from '@clack/prompts';
import type { Profile } from '../../configuration/schema.js';
import { defaultProfiles } from '../../configuration/initialize.js';
import { listModels } from '../../providers/catalog.js';
import { selected } from '../ui.js';
import { explainError } from './errors.js';
import type { SessionKeys } from './service.js';
import { activity } from './activity.js';
import { chooseCodex } from './codex.js';
import { liveSelect } from './live-select.js';
import { readText } from './text-reader.js';
import { page } from './screen.js';

export const providerNames: Record<Profile['provider'], string> = {
  qwen: 'Qwen · Alibaba Cloud',
  openai: 'OpenAI · GPT',
  anthropic: 'Anthropic · Claude',
  google: 'Google · Gemini',
  'openai-compatible': 'Локальная модель или другой сервис',
  codex: 'Codex · мой аккаунт · без ключа API',
};
const keyPages: Record<Profile['provider'], string> = {
  qwen: 'https://www.alibabacloud.com/help/en/model-studio/get-api-key',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  'openai-compatible':
    'Ключ выдаёт владелец вашего сервера; локальный сервер часто работает без него.',
  codex: 'Вход в аккаунт через официальный клиент Codex.',
};

/** Использует ключ окружения или системного хранилища; новый ключ запрашивает скрыто. */
export async function enterKey(
  profile: Profile,
  keys: SessionKeys,
  replace = false,
): Promise<void> {
  keys.select(profile);
  const name = profile.apiKeyEnv;
  if (!name || (!replace && process.env[name])) return;
  page('Ключ доступа к модели');
  if (!replace && keys.credentials) {
    try {
      const saved = await keys.credentials.get(profile);
      if (saved) {
        keys.set(name, saved);
        return;
      }
    } catch {
      prompts.log.warn('Системное хранилище недоступно. Можно ввести ключ на время этого окна.');
    }
  }
  prompts.log.info('Где получить ключ: ' + keyPages[profile.provider]);
  prompts.log.info('Введите ключ в скрытое поле. API оплачивается отдельно от подписки на чат.');
  const value = selected(
    await prompts.password({
      message: 'Ключ API для ' + providerNames[profile.provider],
      validate: (value) =>
        value.trim() && !/\s/.test(value.trim()) ? undefined : 'Вставьте ключ без пробелов внутри',
    }),
  );
  keys.set(name, value.trim());
  if (keys.credentials) {
    page('Хранение ключа');
    const save = selected(
      await prompts.confirm({
        message: 'Сохранить ключ в защищённом хранилище системы?',
        initialValue: false,
        active: 'Сохранить',
        inactive: 'Только это окно',
      }),
    );
    try {
      if (save) {
        await keys.credentials.save(profile, value.trim());
        prompts.log.success('Ключ сохранён в системном хранилище.');
      } else await keys.credentials.forget(profile);
    } catch {
      prompts.log.warn(
        'Хранилище недоступно. Новый ключ действует в этом окне; прежняя запись хранилища, если была, могла сохраниться.',
      );
    }
  }
}

/** Предлагает готовые подключения и запрашивает технические параметры только при необходимости. */
export async function chooseConnection(keys: SessionKeys): Promise<Profile> {
  const provider = selected(
    await liveSelect<Profile['provider'] | 'help'>({
      title: 'Подключение модели',
      load: async () => ({
        message: 'Какую модель подключим?',
        options: [
          ...Object.entries(providerNames).map(([value, label]) => ({
            value: value as Profile['provider'],
            label,
          })),
          { value: 'help', label: 'У меня пока нет подключения · что выбрать?' },
        ],
      }),
    }),
  );
  if (provider === 'help') {
    await readText('Как подключить модель', [
      {
        id: 'help',
        label: 'Провайдеры',
        text:
          'Для облачной модели создайте ключ в кабинете своего провайдера. Обычная подписка на чат не всегда включает API.\n\n' +
          Object.entries(keyPages)
            .filter(([name]) => name !== 'openai-compatible')
            .map(([name, url]) => providerNames[name as Profile['provider']] + '\n' + url)
            .join('\n\n') +
          '\n\nЕсли на компьютере уже работает Ollama или LM Studio, выберите локальную модель. Этот мастер не устанавливает и не скачивает модели.',
      },
    ]);
    return chooseConnection(keys);
  }
  if (provider === 'codex') return (await chooseCodex()) ?? chooseConnection(keys);
  const defaults = (await defaultProfiles())[provider]!;
  let baseUrl = defaults.baseUrl;
  const address = selected(
    await liveSelect({
      title: 'Адрес подключения',
      load: async () => ({
        message: 'Подключение к ' + providerNames[provider],
        options: [
          {
            value: 'default',
            label:
              provider === 'openai-compatible' ? 'Ollama на этом компьютере' : 'Стандартный API',
            hint: baseUrl,
          },
          ...(provider === 'qwen'
            ? [
                { value: 'china', label: 'Qwen · Китай (Пекин)' },
                { value: 'coding', label: 'Qwen · международный Coding Plan' },
              ]
            : []),
          { value: 'custom', label: 'Другой адрес', hint: 'прокси, LM Studio или свой сервер' },
        ],
      }),
    }),
  );
  if (address === 'china') baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  if (address === 'coding') baseUrl = 'https://coding-intl.dashscope.aliyuncs.com/v1';
  if (address === 'custom') {
    page('Адрес подключения');
    baseUrl = selected(
      await prompts.text({
        message: 'Адрес API из настроек сервера',
        initialValue: baseUrl,
        validate: (value) => {
          try {
            const url = new URL(value);
            if (url.username || url.password || url.search || url.hash)
              return 'Вставьте адрес без ключа и параметров';
            return url.protocol === 'https:' ||
              (url.protocol === 'http:' &&
                ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
              ? undefined
              : 'Нужен HTTPS; HTTP допустим для локального сервера';
          } catch {
            return 'Пример: http://127.0.0.1:1234/v1';
          }
        },
      }),
    );
  }
  page('Доступ к модели');
  const needsKey =
    provider !== 'openai-compatible' ||
    selected(
      await prompts.confirm({
        message: 'Сервер требует ключ API?',
        initialValue: false,
        active: 'Да',
        inactive: 'Нет',
      }),
    );
  const profile: Profile = {
    ...defaults,
    provider,
    baseUrl,
    apiKeyEnv: needsKey ? (defaults.apiKeyEnv ?? 'HARNESS_MODEL_API_KEY') : undefined,
  };
  await enterKey(profile, keys);
  while (true) {
    page('Список моделей');
    const spinner = activity();
    spinner.start('Получаю список моделей · генерация текста не запускается');
    try {
      const models = await listModels(
        profile,
        profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined,
      );
      spinner.stop(
        models.length ? 'Список моделей получен' : 'Сервер не предоставил список моделей',
      );
      const model = selected(
        await liveSelect({
          title: 'Список моделей',
          initialValue: models.some((m) => m.id === defaults.model) ? defaults.model : undefined,
          load: async () => ({
            message: 'Выберите модель для задач',
            options: [
              ...models.map((m) => ({ value: m.id, label: m.label })),
              { value: '__manual__', label: 'Ввести название вручную' },
            ],
          }),
        }),
      );
      if (model !== '__manual__') {
        profile.model = model;
        return profile;
      }
      break;
    } catch (error) {
      spinner.stop('Список моделей недоступен');
      if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL') throw error;
      const action = selected(
        await liveSelect({
          title: 'Список моделей недоступен',
          load: async () => ({
            summary: explainError(error),
            message: 'Как продолжить?',
            options: [
              { value: 'retry', label: 'Повторить подключение' },
              ...(profile.apiKeyEnv ? [{ value: 'key', label: 'Вставить другой ключ' }] : []),
              {
                value: 'manual',
                label: 'Указать модель вручную',
                hint: 'если сервер не поддерживает список',
              },
              { value: 'back', label: 'Вернуться к выбору провайдера' },
            ],
          }),
        }),
      );
      if (action === 'back') return chooseConnection(keys);
      if (action === 'manual') break;
      if (action === 'key') await enterKey(profile, keys, true);
    }
  }
  page('Название модели');
  profile.model = selected(
    await prompts.text({
      message: 'Название модели из кабинета провайдера или настроек локального сервера',
      initialValue: defaults.model === 'local-model' ? undefined : defaults.model,
      validate: (value) => (value.trim() ? undefined : 'Нужно название модели'),
    }),
  ).trim();
  prompts.log.info('Доступ к этой модели будет проверен при первой задаче.');
  return profile;
}
