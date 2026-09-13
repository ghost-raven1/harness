import { randomUUID } from 'node:crypto';

/** Создаёт только известные состояния в изолированном сервисе для просмотра редких экранов. */
export async function seedScreenInventory(app, params) {
  if (params.kind === 'learning') return learning(app, params.runId);
  if (params.kind !== 'run') throw new Error('Неизвестное состояние экрана');
  if (!['paused', 'failed', 'cancelled'].includes(params.status))
    throw new Error('Нельзя подменять работающую задачу');
  await app.runtime.cancel(params.runId);
  await app.sessions.mutate(params.runId, 'fixture.screen_state', {}, (run) => {
    run.status = params.status;
    const agent = run.agents[run.rootAgentId];
    agent.status = params.status === 'failed' ? 'failed' : 'cancelled';
    if (params.status === 'failed') run.error = 'Проверочная ошибка: модель недоступна.';
    if (params.status === 'paused' && params.legacyQuota)
      run.error =
        'Достигнута квота этой задачи. Она сохранена на паузе; можно добавить токены и продолжить.';
    if (params.unknown) {
      const call = {
        id: 'inventory-write',
        name: 'fs.write',
        arguments: JSON.stringify({ path: 'Проверить.txt', content: 'Проверочный текст' }),
      };
      agent.pending = [call];
      agent.messages.push({ role: 'assistant', content: '', toolCalls: [call] });
      run.invocations[call.id] = {
        id: call.id,
        agentId: agent.id,
        role: agent.role,
        call,
        effect: 'write',
        status: 'unknown',
        result: 'Связь была прервана.',
        startedAt: new Date().toISOString(),
      };
    }
  });
  return { runId: params.runId };
}

async function learning(app, runId) {
  const ids = Array.from(
    { length: 8 },
    (_, index) => '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
  );
  await app.learning.store.update((state) => {
    state.paused = true;
    state.candidates = {};
    state.evidence = {};
    state.reports = {};
    for (const [index, id] of ids.entries()) {
      const proof = randomUUID();
      state.evidence[proof] = {
        id: proof,
        runId,
        agentId: 'fixture',
        role: 'coordinator',
        kind: 'feedback',
        content: 'Проверено на локальном контрольном примере.',
        verified: true,
      };
      state.candidates[id] = {
        id,
        sourceRunId: runId,
        workspace: app.config.value.workspaces[0],
        role: 'coordinator',
        profile: 'fixture',
        title: 'Правило ' + (index + 1),
        lesson: 'Перед изменением файла проверь его текущее содержимое.',
        appliesWhen: 'При работе с проверочным проектом.',
        evidenceIds: [proof],
        status: index < 2 ? 'published' : index === 2 ? 'rejected' : 'candidate',
        ...(index === 2 ? { reason: 'Контрольный пример выявил ошибку.' } : {}),
        fingerprint: id,
      };
      state.reports[id] = {
        candidateId: id,
        baselineVersion: 'baseline',
        suiteHash: 'fixture-suite',
        passed: index < 2,
        reason: index < 2 ? 'Все проверки пройдены.' : 'Недостаточно подтверждений.',
        results: [
          {
            caseId: 'fixture-case',
            variant: 'candidate',
            repetition: 1,
            passed: index < 2,
            detail: 'Проверка ожидаемого результата.',
          },
        ],
      };
    }
    state.activeVersion = 'inventory-v1';
    state.releases['inventory-v1'] = {
      id: 'inventory-v1',
      parentId: 'baseline',
      createdAt: new Date().toISOString(),
      candidateIds: ids.slice(0, 2),
    };
    state.jobs = [
      { id: randomUUID(), runId, role: 'coordinator', status: 'done', candidateId: ids[0] },
      {
        id: randomUUID(),
        runId,
        role: 'coordinator',
        status: 'inactive',
        error: 'Нет доказательств.',
      },
    ];
  });
  return { ids };
}
