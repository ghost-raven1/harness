import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browseKnowledge } from '../src/interfaces/guided/knowledge.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { isMissingResource, ResourceNotFoundError } from '../src/shared/resource-errors.js';
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
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture() {
  let removed = false;
  const candidate: LearningInspectView['candidate'] = {
    id: 'a0000000-0000-4000-8000-000000000001',
    sourceRunId: 'run',
    workspace: '/fixture',
    profile: 'test',
    role: 'coordinator',
    title: 'Прежний урок',
    lesson: 'Старый приватный текст',
    appliesWhen: 'При проверке',
    evidenceIds: [],
    status: 'candidate',
    fingerprint: 'fixture',
  };
  const request = vi.fn(async (method: string) => {
    if (method === 'learning.inspect' || method === 'learning.export') {
      if (removed) throw new ResourceNotFoundError('lesson');
      return { candidate, evidence: [] };
    }
    return {
      activeVersion: 'baseline',
      activeCandidateIds: [],
      enabled: true,
      paused: false,
      dailyLimit: null,
      daily: { date: '', tokens: 0 },
      jobs: [],
      candidates: removed ? [] : [candidate],
      releases: [],
    } satisfies LearningStatusView;
  });
  const context = {
    request,
    directory: () => '/fixture',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  } as CliContext;
  return {
    candidate,
    context,
    request,
    remove: () => {
      removed = true;
    },
  };
}

it.each(['reader', 'export'] as const)(
  '%s: удаление очищает урок и после Esc возвращает каталог',
  async (stage) => {
    const value = fixture();
    vi.mocked(liveSelect).mockResolvedValueOnce(value.candidate.id);
    vi.mocked(readText)
      .mockImplementationOnce(async (_title, tabs, options) => {
        expect(JSON.stringify(tabs)).toContain(value.candidate.lesson);
        if (stage === 'export') return 'action';
        value.remove();
        const error = await options!.load!().catch((error: unknown) => error);
        expect(options!.exitOnError!(error)).toBe(true);
        throw error;
      })
      .mockImplementationOnce(async (title, tabs) => {
        expect(title).toBe('Урок удалён');
        expect(JSON.stringify(tabs)).not.toContain(value.candidate.lesson);
        return 'back';
      });
    if (stage === 'export')
      vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
        await options.load();
        value.remove();
        return 'save';
      });
    vi.mocked(liveSelect).mockImplementationOnce(async (options) => {
      expect(options.title).toBe('База знаний');
      const menu = await options.load();
      expect(menu.message).toBe('Уроков пока нет');
      expect(menu.options.some((item) => item.value === value.candidate.id)).toBe(false);
      return 'back';
    });
    await browseKnowledge(value.context);
    expect(readText).toHaveBeenCalledTimes(2);
  },
);

it('удаление в меню действий убирает название и экспорт, оставляя возврат к списку', async () => {
  const value = fixture();
  vi.mocked(liveSelect)
    .mockResolvedValueOnce(value.candidate.id)
    .mockImplementationOnce(async (options) => {
      expect((await options.load()).message).toContain(value.candidate.title);
      value.remove();
      const next = await options.load();
      expect(next.summary).toContain('Урок удалён');
      expect(next.options.map((item) => item.value)).toEqual(['back']);
      expect(JSON.stringify(next)).not.toContain(value.candidate.title);
      return 'back';
    })
    .mockResolvedValueOnce('back');
  vi.mocked(readText).mockResolvedValueOnce('action');
  await browseKnowledge(value.context);
  expect(value.request.mock.calls.some(([method]) => method === 'learning.export')).toBe(false);
});

it('настоящий reader закрывается только на отсутствии записи и прекращает обновления', async () => {
  vi.useFakeTimers();
  const actual = await vi.importActual<typeof import('../src/interfaces/guided/text-reader.js')>(
    '../src/interfaces/guided/text-reader.js',
  );
  const properties: Array<[object, string, PropertyDescriptor | undefined]> = [];
  const replace = (target: object, key: string, value: unknown): void => {
    properties.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
    Object.defineProperty(target, key, { configurable: true, value });
  };
  const wasPaused = process.stdin.isPaused(),
    priorTerm = process.env.TERM;
  replace(process.stdin, 'isTTY', true);
  replace(process.stdout, 'isTTY', true);
  replace(process.stdin, 'setRawMode', vi.fn());
  process.env.TERM = 'xterm';
  const missing = new ResourceNotFoundError('lesson');
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockRejectedValue(missing);
  try {
    const result = actual
      .readText('Урок', [{ id: 'lesson', label: 'Урок', text: 'Прежний текст' }], {
        load,
        exitOnError: (error) => isMissingResource(error, 'lesson'),
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(drawing.draw.mock.calls.at(-1)?.[0]).toContain('Прежний текст');
    expect(drawing.draw.done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(missing);
    expect(drawing.draw.done).toHaveBeenCalledOnce();
    const count = drawing.draw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(drawing.draw).toHaveBeenCalledTimes(count);
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
