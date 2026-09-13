import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../dist/configuration/loader.js';
import { SdkModelProvider } from '../dist/providers/sdk-provider.js';

/** Проверяет реальный облачный транспорт без файловых операций и без печати ключа. */
const config = await loadConfig(resolve(process.env.HARNESS_CLOUD_CONFIG ?? 'config/harness.json'));
const profile =
  config.value.profiles[process.env.HARNESS_CLOUD_PROFILE ?? config.value.defaultProfile];
const report = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  cloudTransportPassed: false,
  fullOpenCodeLearningScenarioPassed: false,
  requests: 0,
};
if (!profile || !profile.apiKeyEnv || !process.env[profile.apiKeyEnv]) {
  report.blocked =
    'Нет ключа выбранного облачного профиля. Задайте его через окружение и повторите playtest:cloud.';
  process.exitCode = 2;
} else {
  const provider = new SdkModelProvider(1),
    nonce = randomUUID();
  const bounded = { ...profile, retries: 0, outputTokens: 512, timeoutMs: 30000 };
  const definition = {
    name: 'test.verify',
    description: 'Return the supplied nonce to verify the connection.',
    effect: 'read',
    schema: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  };
  const messages = [
    {
      role: 'system',
      content:
        'This is a transport test. Call test.verify exactly once with the supplied nonce; after receiving the tool result reply HARNESS_CLOUD_OK.',
    },
    { role: 'user', content: nonce },
  ];
  try {
    report.requests++;
    const first = await provider.generate({ profile: bounded, messages, tools: [definition] });
    const call = first.calls[0];
    if (
      first.finish !== 'tools' ||
      first.calls.length !== 1 ||
      call.name !== 'test.verify' ||
      JSON.parse(call.arguments).nonce !== nonce
    )
      throw new Error('TOOL_CONTRACT');
    messages.push(
      { role: 'assistant', content: first.text, toolCalls: first.calls },
      { role: 'tool', toolCallId: call.id, content: 'Verified. Reply HARNESS_CLOUD_OK.' },
    );
    report.requests++;
    const second = await provider.generate({ profile: bounded, messages, tools: [definition] });
    if (
      second.finish !== 'stop' ||
      second.calls.length ||
      second.text.trim() !== 'HARNESS_CLOUD_OK'
    )
      throw new Error('FINAL_CONTRACT');
    report.cloudTransportPassed = true;
    report.usage = {
      input: first.usage.input + second.usage.input,
      output: first.usage.output + second.usage.output,
    };
  } catch {
    report.error =
      'Проверка облачного транспорта не прошла. Проверьте доступ к модели и контракт tool calls; ключ и ответ API в отчёт не включены.';
    process.exitCode = 1;
  }
}
await writeFile('docs/playtest-cloud.json', JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
