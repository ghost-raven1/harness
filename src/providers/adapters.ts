import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import type { Profile } from '../configuration/schema.js';
import { ProviderError } from './errors.js';

/** Официальные адаптеры AI SDK реализуют протоколы конкретных провайдеров. */
export function createModel(profile: Profile, fetcher: typeof fetch): LanguageModelV1 {
  const apiKey = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
  if (profile.apiKeyEnv && !apiKey)
    throw new ProviderError('Missing API key environment variable: ' + profile.apiKeyEnv);
  const customFetch: typeof fetch = (input, init) => {
    if (init?.body && typeof init.body === 'string' && Object.keys(profile.options).length) {
      init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...profile.options }) };
    }
    return fetcher(input, init);
  };
  const options = {
    baseURL: profile.baseUrl,
    apiKey: apiKey ?? 'not-required',
    fetch: customFetch,
  };
  switch (profile.provider) {
    case 'codex':
      throw new ProviderError('Codex использует отдельный адаптер app-server.');
    case 'openai':
      return createOpenAI(options).chat(profile.model);
    case 'anthropic':
      return createAnthropic(options).languageModel(profile.model);
    case 'google':
      return createGoogleGenerativeAI(options).languageModel(profile.model);
    case 'qwen':
    case 'openai-compatible':
      return createOpenAICompatible({ ...options, name: profile.provider }).languageModel(
        profile.model,
      );
  }
}
