import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { UsageLedger } from '../src/runtime/usage.js';
import { harness, output, ScriptedProvider } from './helpers.js';

it('игнорирует прежние лимиты задачи и суток, сохраняя расход после перезапуска', async () => {
  const source = new ScriptedProvider(() => output('Готово'));
  const app = await harness(source, (config) => {
    config.limits.runTokens = 1;
    config.limits.dailyTokens = 1;
    config.learning.dailyTokens = 1;
  });
  const { runId } = await app.runtime.start({
    message: 'Проверка',
    workspace: app.workspace,
    requestKey: randomUUID(),
  });
  await app.runtime.wait(runId);
  expect(app.sessions.get(runId).status).toBe('completed');
  expect(source.requests).toHaveLength(1);
  const before = await app.runtime.usage.status(runId);
  expect(before).toMatchObject({ dailyLimit: null, runLimit: null, warning: false });
  expect(before.runReserved).toBeGreaterThan(1);
  expect(before.daily.reportedTasks).toBe(15);
  expect(await new UsageLedger(app.sessions).status(runId)).toEqual(before);

  const file = join(app.sessions.directory, 'usage.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.days[before.date].extra = 123;
  saved.runs[runId].extra = 456;
  await writeFile(file, JSON.stringify(saved));
  const restored = new UsageLedger(app.sessions);
  await restored.provider(source, runId).generate(source.requests[0]!);
  const next = await restored.status(runId);
  expect(next).toMatchObject({ dailyLimit: null, runLimit: null, warning: false });
  expect(next.runReserved).toBe(before.runReserved * 2);
  expect(next.daily.reportedTasks).toBe(30);
  const roundtrip = JSON.parse(await readFile(file, 'utf8'));
  expect(roundtrip.days[before.date].extra).toBe(123);
  expect(roundtrip.runs[runId].extra).toBe(456);
});

it('учитывает все конкурентные запросы, повторы и расход в исходные сутки запроса', async () => {
  let today = '2026-09-12';
  const source = new ScriptedProvider(() => {
    today = '2026-09-13';
    return output('Ответ');
  });
  const app = await harness(source);
  const ledger = new UsageLedger(app.sessions, () => today);
  const request = {
    profile: { ...app.snapshot.value.profiles.test!, outputTokens: 1000, retries: 1 },
    messages: [{ role: 'user' as const, content: 'Тест' }],
    tools: [],
  };
  const amount =
    (Buffer.byteLength(
      JSON.stringify({
        messages: request.messages,
        tools: request.tools,
        options: request.profile.options,
      }),
    ) +
      1000 +
      2048) *
    2;
  await Promise.all([
    ledger.provider(source).generate(request),
    ledger.provider(source).generate(request),
  ]);
  expect(source.requests).toHaveLength(2);
  const saved = JSON.parse(await readFile(join(app.sessions.directory, 'usage.json'), 'utf8'));
  const total = Object.values(saved.days) as Array<{ learning: number; reportedLearning: number }>;
  expect(total.reduce((sum, day) => sum + day.learning, 0)).toBe(amount * 2);
  expect(total.reduce((sum, day) => sum + day.reportedLearning, 0)).toBe(30);
  expect(saved.days['2026-09-12'].reportedLearning).toBeGreaterThan(0);
  today = '2026-09-14';
  expect((await ledger.status()).daily).toMatchObject({ learning: 0, tasks: 0 });
  await ledger.provider(source).generate(request);
  const acrossMidnight = new UsageLedger(app.sessions, () => '2026-09-14');
  expect((await acrossMidnight.status()).daily).toMatchObject({
    learning: amount,
    reportedLearning: 15,
  });
});

it('сохраняет оценку после обрыва API и не прекращает следующие запросы по расходу', async () => {
  const source = new ScriptedProvider(() => {
    throw new Error('Обрыв');
  });
  const app = await harness(source);
  const ledger = new UsageLedger(app.sessions);
  const request = {
    profile: { ...app.snapshot.value.profiles.test!, retries: 1 },
    messages: [],
    tools: [],
  };
  await expect(ledger.provider(source).generate(request)).rejects.toThrow('Обрыв');
  const first = (await ledger.status()).daily.learning;
  expect(first).toBeGreaterThan(0);
  const restored = new UsageLedger(app.sessions);
  await expect(restored.provider(source).generate(request)).rejects.toThrow('Обрыв');
  expect(source.requests).toHaveLength(2);
  expect((await restored.status()).daily).toMatchObject({
    learning: first * 2,
    reportedLearning: 0,
  });
  await writeFile(join(app.sessions.directory, 'usage.json'), '{');
  await expect(new UsageLedger(app.sessions).provider(source).generate(request)).rejects.toThrow(
    'повреждён',
  );
  expect(source.requests).toHaveLength(2);
});

it('не обращается к API и не записывает расход заранее отменённого запроса', async () => {
  const source = new ScriptedProvider(() => output('Не должен вызываться'));
  const app = await harness(source);
  const controller = new AbortController();
  controller.abort();
  await expect(
    app.runtime.usage.provider(source).generate({
      profile: app.snapshot.value.profiles.test!,
      messages: [],
      tools: [],
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(source.requests).toHaveLength(0);
  expect((await app.runtime.usage.status()).daily.learning).toBe(0);
});
