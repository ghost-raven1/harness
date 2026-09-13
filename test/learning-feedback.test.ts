import { it, expect } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, ScriptedProvider, output, call, cleanup } from './helpers.js';
import { LearningService } from '../src/learning/service.js';
import { FileLearningStore } from '../src/learning/store.js';
import { ProviderError } from '../src/providers/errors.js';
import { evaluationCaseSchema } from '../src/configuration/schema.js';
import type { ModelOutput, ModelRequest } from '../src/providers/types.js';

async function feedbackFixture(
  options: {
    interrupt?: boolean;
    toolEvidence?: boolean;
    evaluate?: (request: ModelRequest) => Promise<ModelOutput | undefined>;
  } = {},
) {
  let interrupted = false;
  const provider = new ScriptedProvider(async (request) => {
    if (request.messages[0]!.content.startsWith('Extract one')) {
      const observations = JSON.parse(request.messages[1]!.content).observations;
      return output(
        JSON.stringify({
          title: 'Проверка файла',
          lesson: 'Проверь UTF-8.',
          appliesWhen: 'После изменения текста',
          evidenceIds: [observations[0].id],
        }),
      );
    }
    const text = request.messages.map((item) => item.content).join('\n');
    if (text.includes('TARGET') || text.includes('HOLDOUT')) {
      const override = await options.evaluate?.(request);
      if (override) return override;
    }
    if (text.includes('TARGET')) {
      if (options.interrupt && !interrupted && text.includes('UTF-8')) {
        interrupted = true;
        throw new ProviderError('Квота', false, false, { kind: 'quota' });
      }
      return output(text.includes('UTF-8') ? 'TARGET_OK' : 'OLD');
    }
    if (text.includes('HOLDOUT')) return output('HOLDOUT_OK');
    if (options.toolEvidence && !request.messages.some((item) => item.role === 'tool'))
      return output('', [call('read', 'fs.read', { path: 'sample.txt' })]);
    return output('Проверка завершена');
  });
  const app = await harness(provider, (config) => {
    config.learning.enabled = true;
    config.learning.cases = [
      evaluationCaseSchema.parse({
        id: 'target',
        kind: 'target',
        role: 'coordinator',
        prompt: 'TARGET',
        expect: { includes: ['TARGET_OK'] },
      }),
      evaluationCaseSchema.parse({
        id: 'holdout',
        kind: 'holdout',
        role: 'coordinator',
        prompt: 'HOLDOUT',
        expect: { includes: ['HOLDOUT_OK'] },
      }),
    ];
  });
  await writeFile(join(app.workspace, 'sample.txt'), 'Наблюдаемый результат');
  const service = new LearningService(
    app.learning,
    app.sessions,
    app.snapshot.value,
    provider,
    app.policy,
    () => false,
  );
  cleanup(() => service.close());
  const { runId } = await app.runtime.start({
    workspace: app.workspace,
    message: 'Источник',
    requestKey: 'feedback-source',
  });
  await app.runtime.wait(runId);
  if (options.toolEvidence) await service.enqueue(runId);
  await service.feedback(runId, true, 'Проверено человеком');
  return { ...app, service, provider, runId };
}

it('не возобновляет отозванный урок после паузы провайдера и перезапуска', async () => {
  const app = await feedbackFixture({ interrupt: true });
  expect(await app.service.processNext()).toBe(false);
  const candidate = Object.values(app.learning.read().candidates)[0]!;
  expect(candidate.status).toBe('evaluating');
  expect(app.learning.read().reports[candidate.id]!.results).toHaveLength(1);
  await app.service.feedback(app.runId, false, 'Урок ошибочный', candidate.id);
  expect(app.learning.read().jobs[0]!.status).toBe('inactive');
  // Старый сервис мог сохранить отозванного кандидата вместе с ожидающим заданием.
  await app.learning.update((state) => {
    state.jobs[0]!.status = 'queued';
  });
  const restored = new FileLearningStore(join(app.directory, 'state'));
  await restored.initialize();
  const service = new LearningService(
    restored,
    app.sessions,
    app.snapshot.value,
    app.provider,
    app.policy,
    () => false,
  );
  cleanup(() => service.close());
  const requests = app.provider.requests.length;
  await service.pause(false);
  await service.processNext();
  expect(restored.read().candidates[candidate.id]).toMatchObject({
    status: 'revoked',
    reason: 'Урок ошибочный',
  });
  expect(restored.read().jobs[0]!.status).toBe('inactive');
  expect(restored.read().activeVersion).toBe('baseline');
  expect(app.provider.requests).toHaveLength(requests);
});

it('опровержение без candidateId отменяет старое подтверждение и его ожидающее обучение', async () => {
  const app = await feedbackFixture();
  await app.service.feedback(app.runId, false, 'Предыдущее подтверждение ошибочно');
  expect(await app.service.processNext()).toBe(false);
  expect(Object.values(app.learning.read().evidence).every((item) => !item.verified)).toBe(true);
  expect(app.learning.read().jobs[0]!.status).toBe('inactive');
  expect(app.provider.requests).toHaveLength(1);
  await app.service.feedback(app.runId, true, 'Проверено человеком');
  expect(app.learning.read().jobs).toHaveLength(1);
  expect(Object.values(app.learning.read().evidence).every((item) => !item.verified)).toBe(true);
  await app.service.feedback(app.runId, true, 'Повторно проверено после исправления');
  expect(await app.service.processNext()).toBe(true);
  const proposal = app.provider.requests.find((request) =>
    request.messages[0]!.content.startsWith('Extract one'),
  )!;
  const input = JSON.parse(proposal.messages[1]!.content);
  expect(input.observations).toHaveLength(1);
  expect(input.observations[0].content).toContain('Повторно проверено');
  expect(input.counterEvidence[0].content).toContain('Предыдущее подтверждение ошибочно');
});

it('поздний отрицательный результат оценки не перезаписывает человеческий отзыв урока', async () => {
  let revoke: (() => Promise<void>) | undefined;
  const app = await feedbackFixture({
    evaluate: async (request) => {
      if (revoke) {
        const current = revoke;
        revoke = undefined;
        await current();
      }
      if (request.messages.at(-1)!.content === 'TARGET') return output('Проверка не пройдена');
      return undefined;
    },
  });
  revoke = () => app.service.feedback(app.runId, false, 'Я опроверг прежнюю проверку');
  await app.service.processNext();
  const state = app.learning.read();
  expect(Object.values(state.candidates)[0]).toMatchObject({
    status: 'revoked',
    reason: 'Я опроверг прежнюю проверку',
  });
  expect(state.jobs[0]!.status).toBe('inactive');
  expect(state.activeVersion).toBe('baseline');
});

it('отзыв во время успешного сравнения прекращает новые запросы и сохраняет причину после перезапуска', async () => {
  let revoke: (() => Promise<void>) | undefined;
  let requestsWhenRevoked = 0;
  const reason = 'Я опроверг прежнюю проверку';
  const app = await feedbackFixture({
    evaluate: async () => {
      if (revoke) {
        const current = revoke;
        revoke = undefined;
        await current();
      }
      return undefined;
    },
  });
  revoke = async () => {
    await app.service.feedback(app.runId, false, reason);
    requestsWhenRevoked = app.provider.requests.length;
  };
  await app.service.processNext();
  const state = app.learning.read();
  expect.soft(app.provider.requests).toHaveLength(requestsWhenRevoked);
  expect.soft(state.jobs[0]).toMatchObject({ status: 'inactive', error: reason });
  expect(Object.values(state.candidates)[0]).toMatchObject({ status: 'revoked', reason });
  expect(state.activeVersion).toBe('baseline');
  const restored = new FileLearningStore(join(app.directory, 'state'));
  await restored.initialize();
  expect(restored.read().jobs).toEqual(state.jobs);
  expect(restored.read().candidates).toEqual(state.candidates);
});

it.each(['успех', 'провал'] as const)(
  'последнее сравнение (%s) не публикует отозванный урок и не теряет причину пользователя',
  async (result) => {
    let revoke: (() => Promise<void>) | undefined;
    let comparisons = 0;
    const reason = 'Проверка пользователя оказалась неверной';
    const app = await feedbackFixture({
      evaluate: async () => {
        if (++comparisons === 12) {
          await revoke!();
          if (result === 'провал') return output('Проверка не пройдена');
        }
        return undefined;
      },
    });
    revoke = () => app.service.feedback(app.runId, false, reason);
    await app.service.processNext();
    expect(comparisons).toBe(12);
    const state = app.learning.read();
    expect(state.jobs[0]).toMatchObject({ status: 'inactive', error: reason });
    expect(Object.values(state.candidates)[0]).toMatchObject({ status: 'revoked', reason });
    expect(state.activeVersion).toBe('baseline');
    expect(Object.keys(state.releases)).toEqual(['baseline']);
    const restored = new FileLearningStore(join(app.directory, 'state'));
    await restored.initialize();
    expect(restored.read()).toEqual(state);
  },
);

it.each(['rate_limit', 'quota'] as const)(
  'поздний %s не возвращает отозванное задание в очередь',
  async (kind) => {
    let revoke: (() => Promise<void>) | undefined;
    const retryAt = new Date(Date.now() + 120000).toISOString();
    const app = await feedbackFixture({
      evaluate: async () => {
        await revoke!();
        throw new ProviderError('Поздний ответ провайдера о лимите', true, false, {
          kind,
          retryAt,
        });
      },
    });
    revoke = () => app.service.feedback(app.runId, false, 'Я опроверг прежнюю проверку');
    expect(await app.service.processNext()).toBe(false);
    const state = app.learning.read();
    expect(state.paused).toBe(true);
    expect(state.jobs[0]).toMatchObject({
      status: 'inactive',
      error: 'Я опроверг прежнюю проверку',
    });
    expect(state.jobs[0]!.retryAt).toBeUndefined();
    expect(Object.values(state.candidates)[0]).toMatchObject({
      status: 'revoked',
      reason: 'Я опроверг прежнюю проверку',
    });
    const restored = new FileLearningStore(join(app.directory, 'state'));
    await restored.initialize();
    expect(restored.read().jobs).toEqual(state.jobs);
    const requests = app.provider.requests.length;
    await app.service.pause(false);
    expect(await app.service.processNext()).toBe(false);
    expect(app.provider.requests).toHaveLength(requests);
  },
);

it('откатывает опубликованный урок по опровергнутому подтверждению, сохраняя старую версию запуска', async () => {
  const app = await feedbackFixture();
  await app.service.processNext();
  const learned = app.learning.read();
  const candidate = Object.values(learned.candidates)[0]!;
  const next = await app.runtime.start({
    workspace: app.workspace,
    message: 'Следующая задача',
    requestKey: 'pinned-experience',
  });
  await app.runtime.wait(next.runId);
  await app.service.feedback(app.runId, false, 'Результат оказался неверным');
  expect(app.learning.read().activeVersion).toBe('baseline');
  expect(app.learning.read().candidates[candidate.id]!.status).toBe('revoked');
  expect(app.learning.read().releases[learned.activeVersion]!.revoked).toBe(true);
  expect(app.sessions.get(next.runId).learningVersion).toBe(learned.activeVersion);
  expect(app.learning.lessons(learned.activeVersion, app.workspace, 'coordinator', 'test')).toEqual(
    ['После изменения текста: Проверь UTF-8.'],
  );
  const restored = new FileLearningStore(join(app.directory, 'state'));
  await restored.initialize();
  expect(restored.read().activeVersion).toBe('baseline');
  expect(restored.read().candidates[candidate.id]!.status).toBe('revoked');
});

it('общая отрицательная оценка не отменяет проверяемое наблюдение инструмента', async () => {
  const app = await feedbackFixture({ toolEvidence: true });
  await app.service.processNext();
  const learned = app.learning.read();
  const candidate = Object.values(learned.candidates)[0]!;
  expect(learned.evidence[candidate.evidenceIds[0]!]!.kind).toBe('tool');
  await app.service.feedback(app.runId, false, 'В ответе обнаружена ошибка');
  expect(app.learning.read().activeVersion).toBe(learned.activeVersion);
  expect(app.learning.read().candidates[candidate.id]!.status).toBe('published');
  expect(app.learning.read().evidence[candidate.evidenceIds[0]!]!.verified).toBe(true);
});

it('восстановление неизменённой очереди не переписывает снимок и полный журнал', async () => {
  const app = await feedbackFixture({ toolEvidence: true });
  await app.service.processNext();
  const journal = join(app.directory, 'state/learning.jsonl');
  const snapshot = join(app.directory, 'state/learning.json');
  const before = [await readFile(journal, 'utf8'), await readFile(snapshot, 'utf8')];
  const state = app.learning.read();
  await app.service.initialize();
  await app.service.initialize();
  expect(app.learning.read()).toEqual(state);
  expect([await readFile(journal, 'utf8'), await readFile(snapshot, 'utf8')]).toEqual(before);
  await app.service.pause(true);
  expect(await readFile(journal, 'utf8')).not.toBe(before[0]);
  const restored = new FileLearningStore(join(app.directory, 'state'));
  await restored.initialize();
  expect(restored.read().paused).toBe(true);
});

it('ошибка зеркального снимка не отменяет зафиксированную оценку и публикацию', async () => {
  const app = await feedbackFixture();
  const snapshot = join(app.directory, 'state/learning.json');
  await rm(snapshot);
  await mkdir(snapshot);
  expect(await app.service.processNext()).toBe(true);
  const state = app.learning.read();
  const candidate = Object.values(state.candidates)[0]!;
  expect(candidate.status).toBe('published');
  expect(state.jobs[0]!.status).toBe('done');
  expect(state.reports[candidate.id]!.results).toHaveLength(12);
  const restored = new FileLearningStore(join(app.directory, 'state'));
  await restored.initialize();
  expect(restored.read()).toEqual(state);
});
