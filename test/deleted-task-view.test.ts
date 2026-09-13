import { beforeEach, expect, it, vi } from 'vitest';
import { followRun } from '../src/interfaces/guided/watch.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { ResourceNotFoundError } from '../src/shared/resource-errors.js';
import type { CliContext, TaskView } from '../src/interfaces/types.js';

const view = vi.hoisted(() => ({
  update: vi.fn(),
  close: vi.fn(),
  connectionStates: [] as boolean[],
}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => undefined }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('../src/interfaces/ui.js', () => ({ note: vi.fn(), labels: {}, decideApproval: vi.fn() }));
vi.mock('../src/interfaces/guided/task-screen.js', () => ({
  TaskScreen: class {
    connectionLost = false;
    feed = { update: view.update };
    close = view.close;
    render() {
      view.connectionStates.push(this.connectionLost);
    }
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  view.connectionStates.length = 0;
});

function client(request: ReturnType<typeof vi.fn>): CliContext {
  return {
    request,
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
  } as CliContext;
}
const task = {
  runId: 'run',
  status: 'completed',
  result: 'Старый приватный ответ',
  approvals: [],
  cursor: 1,
  output: { events: [], cursor: 0, hasMore: false },
} as unknown as TaskView;

it('удаление в другом окне закрывает feed и возвращает к каталогу без переподключения', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(task)
    .mockRejectedValue(new ResourceNotFoundError('task'));
  vi.mocked(readText).mockImplementation(async (title, tabs) => {
    expect(view.close).toHaveBeenCalled();
    expect(title).toBe('Задача удалена');
    expect(JSON.stringify(tabs)).not.toContain(task.result);
    return 'back';
  });
  expect(await followRun(client(request), 'run', { inspect: true })).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  expect(view.connectionStates).not.toContain(true);
  expect(readText).toHaveBeenCalledOnce();
});

it('обычная потеря связи продолжает чтение, а экран удаления не появляется', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValue(task);
  expect(await followRun(client(request), 'run')).toBe(task);
  expect(view.connectionStates).toEqual([true, false]);
  expect(readText).not.toHaveBeenCalled();
});
