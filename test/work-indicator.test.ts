import { stripVTControlCharacters } from 'node:util';
import stringWidth from 'string-width';
import { expect, it } from 'vitest';
import { TaskWork } from '../src/interfaces/guided/task-work.js';
import { workLine } from '../src/interfaces/guided/work-indicator.js';
import { projectWork } from '../src/interfaces/guided/project-work/activity.js';
import { ReaderState } from '../src/interfaces/guided/text-reader.js';
import type { TaskView } from '../src/interfaces/types.js';
import type { OutputEvent } from '../src/sessions/output.js';
import { projectFixture } from './project-ui-fixture.js';

const started = '2026-09-20T00:00:00.000Z';
function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    runId: 'run',
    sessionId: 'session',
    task: 'Проверить проект',
    workspace: '/workspace',
    profile: 'demo',
    status: 'running',
    turns: 1,
    learningVersion: 'baseline',
    usage: { input: 0, output: 0 },
    cursor: 0,
    events: [],
    approvals: [],
    agents: [{ id: 'root', role: 'coordinator', status: 'running' }],
    unknownInvocations: [],
    output: { events: [], cursor: 0, hasMore: false },
    ...overrides,
  };
}
function output(type: OutputEvent['type'], requestId = 'request', agentId = 'root'): OutputEvent {
  return { seq: 1, at: started, requestId, agentId, role: 'coordinator', type };
}

it('различает ожидание, поток и повтор подключения; завершённый запрос не остаётся активным', () => {
  const work = new TaskWork();
  work.output(output('started'));
  expect(work.view(task())).toEqual({ kind: 'busy', label: 'Ожидаю ответ модели', since: started });
  work.output(output('reasoning'));
  expect(work.view(task())?.label).toBe('Получаю ответ модели');
  work.output(output('retry'));
  expect(work.view(task())?.label).toBe('Повтор подключения к модели');
  work.output(output('text'));
  expect(work.view(task())?.since).toBe(started);
  work.output(output('failed'));
  expect(work.view(task())).toEqual({ kind: 'busy', label: 'Задача выполняется' });
});

it('связывает параллельные инструменты и модели по ID независимо от порядка завершения', () => {
  const work = new TaskWork();
  const status = task({
    agents: [
      { id: 'root', role: 'coordinator', status: 'waiting' },
      { id: 'child', role: 'developer', status: 'running' },
    ],
  });
  work.output(output('started'));
  work.output(output('started', 'request-2', 'child'));
  work.output(output('started', 'request-2', 'child'));
  expect(work.view(status)?.label).toBe('Работают модели: 2');
  work.output(output('completed'));
  work.event({
    seq: 1,
    at: started,
    type: 'tool.started',
    payload: {
      agentId: 'root',
      tool: 'process.exec',
      invocationId: 'tool',
    },
  });
  expect(work.view(status)?.label).toBe('Модели: 1 · инструменты: 1');
  work.output(output('completed', 'request-2', 'child'));
  expect(work.view(status)?.label).toBe('Выполняю команду');
  work.event({ seq: 2, type: 'tool.succeeded', payload: { invocationId: 'tool' } });
  expect(work.view(status)?.label).toBe('Задача выполняется');
});

it('при восстановлении страницы не выдаёт старые события за текущую операцию', () => {
  const work = new TaskWork();
  work.output(output('started'));
  expect(work.view(task({ hasMoreEvents: true }))?.label).toBe('Загружаю журнал задачи');
  expect(work.view(task({ output: { events: [], cursor: 1, hasMore: true } }))?.label).toBe(
    'Загружаю журнал задачи',
  );
  expect(work.view(task({ agents: [] }))?.label).toBe('Задача выполняется');
});

it('продолжение после аварии не оживляет старый запрос или чтение из отдельного журнала', () => {
  const work = new TaskWork();
  work.output(output('started'));
  work.event({
    seq: 1,
    at: started,
    type: 'tool.started',
    payload: {
      agentId: 'root',
      invocationId: 'interrupted-read',
      tool: 'fs.read',
    },
  });
  work.event({ seq: 2, at: '2026-09-20T00:01:00.000Z', type: 'run.recovered', payload: {} });
  // Перечитывание потока после журнала соответствует загрузке карточки во втором окне.
  work.output(output('started'));
  expect(work.view(task())).toEqual({ kind: 'busy', label: 'Задача выполняется' });
  const next = { ...output('started', 'after-recovery'), at: '2026-09-20T00:02:00.000Z' };
  work.output(next);
  expect(work.view(task())).toEqual({ kind: 'busy', label: 'Ожидаю ответ модели', since: next.at });
  work.output({ ...next, requestId: 'next-request', at: '2026-09-20T00:03:00.000Z' });
  expect(work.view(task())?.label).toBe('Ожидаю ответ модели');
  work.output({ ...next, type: 'completed', requestId: 'next-request' });
  expect(work.view(task())?.label).toBe('Задача выполняется');

  const secondWindow = new TaskWork();
  secondWindow.output(next);
  secondWindow.event({
    seq: 2,
    at: '2026-09-20T00:01:00.000Z',
    type: 'run.recovered',
    payload: {},
  });
  expect(secondWindow.view(task())?.since).toBe(next.at);
});

it('восстановление убирает прерванный инструмент даже после перевода часов назад', () => {
  const work = new TaskWork();
  work.event({
    seq: 1,
    at: '2026-09-20T12:00:00.000Z',
    type: 'tool.started',
    payload: {
      agentId: 'root',
      invocationId: 'interrupted-read',
      tool: 'fs.read',
    },
  });
  work.event({ seq: 2, at: '2026-09-20T11:00:00.000Z', type: 'run.recovered', payload: {} });
  work.output({ ...output('started', 'after-recovery'), at: '2026-09-20T11:00:01.000Z' });
  expect(work.view(task())?.label).toBe('Ожидаю ответ модели');
  // При неоднозначном времени следующего запроса остаётся общий статус без старого таймера.
  work.output({ ...output('started', 'after-clock-change'), at: '2026-09-20T10:59:00.000Z' });
  expect(work.view(task())).toEqual({ kind: 'busy', label: 'Задача выполняется' });
});

it.each(['completed', 'cancelled', 'failed'] as const)(
  'состояние %s останавливает индикатор даже при неполном потоке',
  (status) => {
    const work = new TaskWork();
    work.output(output('started'));
    expect(work.view(task({ status }))).toBeUndefined();
  },
);

it('пауза, разрешение и неизвестный исход имеют приоритет над анимацией', () => {
  const work = new TaskWork();
  work.output(output('started'));
  expect(work.view(task({ status: 'paused', pauseReason: 'provider' }))?.kind).toBe('waiting');
  expect(work.view(task({ status: 'awaiting_approval' }))?.label).toBe('Нужно ваше разрешение');
  expect(work.view(task({ recoveryRequired: true }))?.kind).toBe('error');
  expect(work.view(task({ unknownInvocations: [{ id: 'tool', tool: 'fs.write' }] }))?.kind).toBe(
    'error',
  );
});

it('индикатор анимируется без новых данных, сохраняет длительность и обезвреживает управляющий текст', () => {
  const work = { kind: 'busy' as const, label: 'Ожидаю\x1b[2J ответ\nмодели', since: started };
  const now = Date.parse(started) + 65_000;
  const first = stripVTControlCharacters(workLine(work, 40, now));
  expect(first).toContain('1:05');
  expect(first).not.toContain('\n');
  expect(first).not.toContain('%');
  expect(stringWidth(first)).toBeLessThanOrEqual(40);
  expect(workLine(work, 40, now + 250)).not.toBe(workLine(work, 40, now));
  expect(workLine({ ...work, kind: 'waiting' }, 40, now + 250)).toBe(
    workLine({ ...work, kind: 'waiting' }, 40, now),
  );
  expect(workLine({ ...work, since: 'unknown' }, 40, now)).not.toContain('NaN');
  expect(workLine(work, 40, Date.parse(started) - 1000)).toContain('0:00');
});

it.each([48, 80])(
  'кадр %s×24 сохраняет вкладку и прокрутку при анимации и скрывает устаревшее состояние',
  (width) => {
    const tabs = ['one', 'two'].map((id) => ({
      id,
      label: id,
      text: Array.from({ length: 60 }, (_, i) => `${id} строка ${i}`).join('\n'),
    }));
    const state = new ReaderState({
      tabs,
      activity: { kind: 'busy', label: 'Проверяю результат' },
    });
    state.frame('Проверки', width, 24);
    state.key({ name: 'tab' });
    state.key({ name: 'pagedown' });
    const frame = state.frame('Проверки', width, 24);
    state.update({ tabs, activity: { kind: 'busy', label: 'Выполняю команду' } });
    const next = state.frame('Проверки', width, 24);
    expect(next).toContain('[two]');
    expect(next.match(/Строки [^\n]+/)?.[0]).toBe(frame.match(/Строки [^\n]+/)?.[0]);
    expect(next.split('\n').length).toBeLessThan(24);
    for (const line of next.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    state.failed(new Error('offline'));
    expect(state.working).toBe(false);
    expect(state.frame('Проверки', width, 24)).not.toContain('Выполняю команду');
  },
);

it('проекты отличают исполнение, ручную проверку и ограничения от продолжающейся работы', () => {
  expect(projectWork(projectFixture({ status: 'planning' }))?.kind).toBe('busy');
  expect(
    projectWork(
      projectFixture({
        status: 'running',
        stages: [{ stageId: 'stage', title: 'Тест', status: 'checking', attempt: 1 }],
      }),
    )?.label,
  ).toBe('Проверяю результат этапа');
  for (const code of ['MANUAL_CHECK', 'PROVIDER_LIMIT', 'PLAN_ACCEPTANCE']) {
    expect(
      projectWork(
        projectFixture({
          status: 'running',
          attention: {
            code,
            reason: 'Нужно решение',
            action: 'inspect',
            priority: 4,
          },
        }),
      ),
    ).toEqual({ kind: 'waiting', label: 'Нужно решение' });
  }
  expect(
    projectWork(projectFixture({ blockers: [{ code: 'STORAGE_UNAVAILABLE', message: 'disk' }] }))
      ?.kind,
  ).toBe('error');
  expect(projectWork(projectFixture({ status: 'completed' }))).toBeUndefined();
});
