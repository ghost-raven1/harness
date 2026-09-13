import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browseKnowledge } from '../src/interfaces/guided/knowledge.js';
import { ReaderState, readText, type ReaderOptions } from '../src/interfaces/guided/text-reader.js';
import { liveSelect, type LiveSelectOptions } from '../src/interfaces/guided/live-select.js';
import type {
  CliContext,
  LearningInspectView,
  LearningStatusView,
} from '../src/interfaces/types.js';

const drawing = vi.hoisted(() => ({ draw: Object.assign(vi.fn(), { done: vi.fn() }) }));
vi.mock('log-update', () => ({ createLogUpdate: () => drawing.draw }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/text-reader.js')>()),
  readText: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function paragraphs(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => 'Строка ' + String(index).padStart(3, '0'),
  ).join('\n');
}

it('обновление сохраняет раздел по id и позицию чтения, End следует за новым концом', () => {
  const reader = new ReaderState({
    tabs: [
      { id: 'lesson', label: 'Урок', text: 'Начальный урок' },
      { id: 'proof', label: 'Доказательства', text: paragraphs(100) },
    ],
  });
  reader.frame('Урок', 47, 24);
  reader.key({ name: 'tab' });
  reader.frame('Урок', 47, 24);
  reader.key({ name: 'pagedown' });
  const before = reader
    .frame('Урок', 47, 24)
    .split('\n')
    .filter((line) => line.includes('Строка 0'));
  reader.update({
    tabs: [
      { id: 'proof', label: 'Доказательства', text: paragraphs(120) },
      { id: 'lesson', label: 'Урок', text: 'Новый урок' },
    ],
  });
  expect(
    reader
      .frame('Урок', 47, 24)
      .split('\n')
      .filter((line) => line.includes('Строка 0')),
  ).toEqual(before);
  expect(reader.frame('Урок', 47, 24)).toContain('[Доказательства]');
  reader.key({ name: 'end' });
  expect(reader.frame('Урок', 47, 24)).toContain('Строка 119');
  reader.update({ tabs: [{ id: 'proof', label: 'Доказательства', text: paragraphs(150) }] });
  expect(reader.frame('Урок', 47, 24)).toContain('Строка 149');
  reader.key({ name: 'home' });
  expect(reader.frame('Урок', 47, 24)).toContain('Строка 000');
  reader.update({ tabs: [{ id: 'proof', label: 'Доказательства', text: paragraphs(180) }] });
  expect(reader.frame('Урок', 47, 24)).toContain('Строка 000');
});

it('ошибка обновления оставляет известный текст и исчезает после восстановления', () => {
  const reader = new ReaderState({
    tabs: [{ id: 'lesson', label: 'Урок', text: 'Сохранённый урок' }],
    subtitle: 'Проверяется',
  });
  reader.failed(new Error('Временный обрыв связи'));
  const failed = reader.frame('Урок', 47, 24);
  expect(failed).toContain('Сохранённый урок');
  expect(failed).toContain('Обновление:');
  reader.update({
    tabs: [{ id: 'lesson', label: 'Урок', text: 'Подтверждённый урок' }],
    subtitle: 'Применяется',
  });
  const restored = reader.frame('Урок', 47, 24);
  expect(restored).toContain('Применяется');
  expect(restored).toContain('Подтверждённый урок');
  expect(restored).not.toContain('Обновление:');
});

it('закрытие настоящего reader прекращает polling и игнорирует незавершённый запрос', async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof import('../src/interfaces/guided/text-reader.js')>(
    '../src/interfaces/guided/text-reader.js',
  );
  const properties: Array<[object, string, PropertyDescriptor | undefined]> = [];
  const replace = (target: object, key: string, value: unknown): void => {
    properties.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, value });
  };
  const wasPaused = process.stdin.isPaused();
  replace(process.stdin, 'isTTY', true);
  replace(process.stdout, 'isTTY', true);
  replace(process.stdin, 'setRawMode', vi.fn());
  const priorTerm = process.env.TERM;
  process.env.TERM = 'xterm';
  let resolve!: (value: { tabs: Array<{ id: string; label: string; text: string }> }) => void;
  const load = vi.fn(
    () =>
      new Promise<{ tabs: Array<{ id: string; label: string; text: string }> }>(
        (done) => (resolve = done),
      ),
  );
  try {
    const view = actual.readText('Урок', [{ id: 'lesson', label: 'Урок', text: 'Начало' }], {
      load,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledOnce();
    process.stdin.emit('keypress', '', { name: 'escape' });
    expect(await view).toBe('back');
    const calls = drawing.draw.mock.calls.length;
    resolve({ tabs: [{ id: 'lesson', label: 'Урок', text: 'Поздний ответ' }] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(drawing.draw).toHaveBeenCalledTimes(calls);
    expect(load).toHaveBeenCalledOnce();
    expect(drawing.draw.done).toHaveBeenCalledOnce();
  } finally {
    for (const [target, key, descriptor] of properties.reverse()) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
    if (wasPaused) process.stdin.pause();
    if (priorTerm === undefined) delete process.env.TERM;
    else process.env.TERM = priorTerm;
  }
});

function fixture() {
  const candidate: LearningInspectView['candidate'] = {
    id: 'a0000000-0000-4000-8000-000000000001',
    sourceRunId: 'run',
    workspace: '/fixture',
    profile: 'test',
    role: 'coordinator',
    title: 'Первый урок',
    lesson: 'Исходный текст',
    appliesWhen: 'При проверке',
    evidenceIds: [],
    status: 'candidate',
    fingerprint: 'fixture',
  };
  let detail: LearningInspectView = { candidate, evidence: [] };
  let state: LearningStatusView = {
    activeVersion: 'baseline',
    activeCandidateIds: [],
    enabled: true,
    paused: false,
    dailyLimit: null,
    daily: { date: '', tokens: 0 },
    jobs: [],
    candidates: [candidate],
    releases: [],
  };
  const request = vi.fn(async (method: string, _params?: unknown) =>
    method === 'learning.export'
      ? { path: '/fixture/exports/lesson.md' }
      : method === 'learning.inspect'
        ? structuredClone(detail)
        : structuredClone(state),
  );
  const context = {
    directory: () => '/fixture',
    request,
    json: () => false,
    interactive: () => true,
    output: vi.fn(),
  } as CliContext;
  return {
    candidate,
    context,
    request,
    get state() {
      return state;
    },
    set state(next: LearningStatusView) {
      state = next;
    },
    get detail() {
      return detail;
    },
    set detail(next: LearningInspectView) {
      detail = next;
    },
  };
}

it('знания появляются и публикуются без ручного обновления каталога', async () => {
  const value = fixture();
  vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
    const before = await options.load();
    expect(before.options.some((item) => item.value === 'refresh')).toBe(false);
    value.state.activeCandidateIds = [value.candidate.id];
    value.state.candidates.push({ ...value.candidate, id: 'second', title: 'Новый урок' });
    const after = await options.load();
    expect(after.summary).toContain('Уроков: 2 · Применяется: 1');
    expect(after.options[0]?.label).toContain('Новый урок');
    return 'back';
  });
  await browseKnowledge(value.context);
  expect(value.request.mock.calls.every(([method]) => method === 'learning.status')).toBe(true);
});

it.each(['queue', 'releases'] as const)(
  '%s перечитывается во время полнотекстового просмотра',
  async (choice) => {
    const value = fixture();
    vi.mocked(liveSelect).mockResolvedValueOnce(choice).mockResolvedValueOnce('back');
    vi.mocked(readText).mockImplementationOnce(async (_title, _tabs, options) => {
      const before = await options!.load!();
      if (choice === 'queue')
        value.state.jobs.push({ id: 'job', runId: 'run', role: 'reviewer', status: 'done' });
      else
        value.state.releases!.push({
          id: 'next',
          createdAt: '2026-01-01',
          candidateIds: [],
          reason: 'Новая версия',
        });
      const after = await options!.load!();
      expect(after.tabs[0]!.text).not.toBe(before.tabs[0]!.text);
      expect(after.tabs[0]!.text).toContain(choice === 'queue' ? 'Обработано' : 'Новая версия');
      return 'back';
    });
    await browseKnowledge(value.context);
  },
);

it('карточка и действия учитывают отзыв урока; экспорт получает актуальные данные на сервисе', async () => {
  const value = fixture();
  vi.mocked(liveSelect).mockResolvedValueOnce(value.candidate.id);
  vi.mocked(readText)
    .mockImplementationOnce(async (_title, _tabs, options: ReaderOptions = {}) => {
      value.state.activeCandidateIds = [value.candidate.id];
      expect((await options.load!()).subtitle).toContain('Применяется');
      value.state.activeCandidateIds = [];
      value.detail.candidate.status = 'revoked';
      expect((await options.load!()).subtitle).toContain('Отозван');
      return 'action';
    })
    .mockResolvedValueOnce('back')
    .mockResolvedValueOnce('back');
  vi.mocked(liveSelect)
    .mockImplementationOnce(async (options: LiveSelectOptions<string | number>) => {
      expect((await options.load()).summary).toContain('Отозван');
      value.detail.candidate.lesson = 'Текст после открытия меню';
      return 'save';
    })
    .mockResolvedValueOnce('back');
  await browseKnowledge(value.context);
  expect(value.request).toHaveBeenCalledWith('learning.export', { id: value.candidate.id });
  expect(readText).toHaveBeenCalledWith('Урок сохранён', [
    expect.objectContaining({
      text: expect.stringContaining('/fixture/exports/lesson.md'),
    }),
  ]);
});
