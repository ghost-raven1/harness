import { beforeEach, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { Command } from 'commander';
import type { CliContext } from '../src/interfaces/types.js';
import type { CommandResponse } from '../src/interfaces/contracts/index.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readText, ReaderState } from '../src/interfaces/guided/text-reader.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import {
  browseIntervalFiles,
  fileChangePageText,
  inspectProjectFile,
} from '../src/interfaces/guided/project-work/changes.js';
import { changeProjectCapture } from '../src/interfaces/guided/project-work/capture.js';
import { registerProjectCommands } from '../src/interfaces/commands/projects.js';
import { projectFixture } from './project-ui-fixture.js';
import {
  prepareProject,
  sendProjectCreation,
} from '../src/interfaces/guided/project-work/setup.js';
import { chooseDraft } from '../src/interfaces/guided/task-drafts.js';
import type { TaskDraft } from '../src/sessions/drafts.js';

vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
vi.mock('../src/interfaces/guided/text-reader.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/text-reader.js')>()),
  readText: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/task-drafts.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/task-drafts.js')>()),
  chooseDraft: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

const interval: CommandResponse<'projects.changeSets'>['items'][number] = {
  id: 'fixed-interval',
  kind: 'stage',
  outcome: 'complete',
  planVersion: 1,
  stageId: 'implement',
  attempt: 0,
  before: { digest: 'a'.repeat(64), files: 1, createdAt: '2026-09-19T12:00:00.000Z' },
  after: { digest: 'b'.repeat(64), files: 1, createdAt: '2026-09-19T12:01:00.000Z' },
};
const file: CommandResponse<'projects.changes'>['items'][number] = {
  fileId: 'opaque-file',
  path: 'src/очень длинное имя файла.ts',
  kind: 'modified',
  typeChanged: false,
  executableChanged: false,
  before: { kind: 'file', digest: 'a'.repeat(64), executable: false, available: true },
  after: { kind: 'file', digest: 'b'.repeat(64), executable: false, available: true },
};

/** Ответ повторяет только адрес запроса; текущая папка не используется как резервный источник. */
function page(params: Record<string, unknown>): CommandResponse<'projects.fileChange'> {
  return {
    projectId: 'project',
    changeSetId: interval.id,
    fileId: file.fileId,
    path: file.path,
    view: params.view as 'diff' | 'before' | 'after',
    state: 'available',
    text: 'Строка\n'.repeat(30),
    offset: params.offset as number,
    totalCharacters: 18000,
    nextOffset: params.offset === 0 ? 16384 : undefined,
    complete: params.offset !== 0,
  };
}

it('страницы трёх вкладок сохраняют неизменный интервал и отдельные смещения', async () => {
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => page(params));
  let reads = 0;
  vi.mocked(readText).mockImplementation(async (_title, tabs, options) => {
    expect(tabs.map((tab) => tab.label)).toEqual(['Изменения', 'До', 'После']);
    await options?.load?.();
    return reads++ === 0 ? 'action' : 'back';
  });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.options.some((option) => option.value === 'next:before')).toBe(true);
    return 'next:before';
  });
  await inspectProjectFile({ request } as unknown as CliContext, 'project', interval, file);
  expect(
    request.mock.calls.every(
      ([method, params]) =>
        method === 'projects.fileChange' &&
        params.changeSetId === interval.id &&
        params.fileId === file.fileId,
    ),
  ).toBe(true);
  expect(
    request.mock.calls.some(([, params]) => params.view === 'before' && params.offset === 16384),
  ).toBe(true);
  expect(
    request.mock.calls
      .filter(([, params]) => params.view !== 'before')
      .every(([, params]) => params.offset === 0),
  ).toBe(true);
});

it('TERM=dumb получает сохранённый текст вместо экрана загрузки даже при наличии TTY', async () => {
  const descriptors = [process.stdin, process.stdout].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  );
  vi.stubEnv('TERM', 'dumb');
  for (const stream of [process.stdin, process.stdout])
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => page(params));
  vi.mocked(readText).mockResolvedValue('back');
  try {
    await inspectProjectFile({ request } as unknown as CliContext, 'project', interval, file);
    const tabs = vi.mocked(readText).mock.calls[0]![1];
    expect(request).toHaveBeenCalledTimes(3);
    expect(tabs.every((tab) => tab.text.includes('Строка\n'))).toBe(true);
    expect(tabs.some((tab) => tab.text.includes('Читаем сохранённое содержимое'))).toBe(false);
  } finally {
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    });
    vi.unstubAllEnvs();
  }
});

it('после перестановки файлов открывается выбранный ID, а не соседняя строка', async () => {
  const other = { ...file, fileId: 'other', path: 'other.ts' };
  let loads = 0;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) =>
    method === 'projects.changes'
      ? {
          projectId: 'project',
          changeSetId: interval.id,
          items: loads++ === 0 ? [file, other] : [other, file],
          total: 2,
          complete: true,
          interval,
        }
      : page(params),
  );
  let menus = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    await options.load();
    if (menus++ === 0) return 'file:' + file.fileId;
    expect(options.initialValue).toBe('file:' + file.fileId);
    return 'back';
  });
  vi.mocked(readText).mockResolvedValue('back');
  await browseIntervalFiles({ request } as unknown as CliContext, 'project', interval);
  expect(
    request.mock.calls
      .filter(([method]) => method === 'projects.fileChange')
      .every(([, params]) => params.fileId === file.fileId),
  ).toBe(true);
});

it.each([48, 80])(
  'сохранённые страницы читаются в %i×24 без исполнения управляющих последовательностей',
  (width) => {
    const text = fileChangePageText({
      ...page({ view: 'diff', offset: 0 }),
      state: 'limited',
      reason: 'Слишком много строк для быстрого сравнения.',
      text: '+ новая строка\u001b[2J\nСохранённый текст',
    });
    expect(text).toContain('вкладках «До» и «После»');
    const reader = new ReaderState({ tabs: [{ id: 'diff', label: 'Изменения', text }] });
    const frame = reader.frame(file.path, width, 24);
    expect(frame).not.toContain('\u001b[2J');
    expect(
      stripAnsi(frame)
        .split('\n')
        .every((line) => stringWidth(line) <= width),
    ).toBe(true);
    expect(stripAnsi(frame).split('\n').length).toBeLessThanOrEqual(24);
  },
);

it('изменение режима снимков блокируется после смены ревизии во втором окне', async () => {
  const view = projectFixture({ status: 'paused' });
  const request = vi.fn(async () => ({ ...view, revision: view.revision + 1 }));
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    expect((await options.load()).available).toBe(false);
    return false;
  });
  await changeProjectCapture({ request } as unknown as CliContext, view);
  expect(request.mock.calls).toHaveLength(1);
});

it('обычные команды старому сервису не передают новые поля, новые действия явно объясняют несовместимость', async () => {
  const request = vi.fn(async (method: string) =>
    method === 'system.info' ? { capabilities: ['projects-review-v1'] } : {},
  );
  const context = { request, output: vi.fn() } as unknown as CliContext;
  const program = new Command().exitOverride();
  registerProjectCommands(program, context);
  await program.parseAsync(['projects', 'export-preview', 'project', '--revision', '1'], {
    from: 'user',
  });
  expect(request).toHaveBeenCalledExactlyOnceWith('projects.exportPreview', {
    projectId: 'project',
    expectedRevision: 1,
    format: 'markdown',
    includeLogs: false,
  });
  await expect(
    program.parseAsync(['projects', 'changes', 'project', 'interval'], { from: 'user' }),
  ).rejects.toThrow('Обновите сервис');
  expect(request.mock.calls.some(([method]) => method === 'projects.changes')).toBe(false);
});

it('настройка будущих снимков сохраняется в черновике без вызова модели', async () => {
  let draft: TaskDraft = {
    id: '44444444-4444-4444-8444-444444444444',
    schemaVersion: 1,
    revision: 1,
    requestKey: 'create-key',
    state: 'editing',
    text: 'Цель',
    updatedAt: '',
    scope: { workspace: '/workspace', profile: 'test', purpose: 'project.create' },
    payload: {
      kind: 'project.create',
      title: 'Проект',
      goal: 'Цель',
      workspace: '/workspace',
      profile: 'test',
      captureEnabled: true,
    },
  };
  vi.mocked(chooseDraft).mockResolvedValue(draft);
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    draft = { ...draft, ...params, revision: draft.revision + 1 } as TaskDraft;
    return draft;
  });
  let menus = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.options.some((option) => option.value === 'capture')).toBe(true);
    return menus++ === 0 ? 'capture' : 'back';
  });
  await prepareProject(
    { request } as unknown as CliContext,
    { workspace: '/workspace', profile: 'test', configFile: '/config' },
    true,
  );
  expect(draft.payload).toMatchObject({ captureEnabled: false });
  expect(request.mock.calls.every(([method]) => method === 'drafts.update')).toBe(true);
  await expect(
    sendProjectCreation(
      { request } as unknown as CliContext,
      { ...draft, state: 'pending' },
      false,
    ),
  ).rejects.toThrow('Черновик сохранён');
});

it('учебная подготовка сразу открывает переданный черновик без лишнего выбора', async () => {
  const draft: TaskDraft = {
    id: '44444444-4444-4444-8444-444444444444',
    schemaVersion: 1,
    revision: 1,
    requestKey: 'demo-key',
    state: 'editing',
    text: 'Цель',
    updatedAt: '',
    scope: { workspace: '/workspace', profile: 'test', purpose: 'project.create' },
    payload: {
      kind: 'project.create',
      title: 'Учебный проект',
      goal: 'Цель',
      workspace: '/workspace',
      profile: 'test',
    },
  };
  const request = vi.fn();
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    expect((await options.load()).summary).toContain('Учебный проект');
    return 'back';
  });
  await prepareProject(
    { request } as unknown as CliContext,
    { workspace: '/workspace', profile: 'test', configFile: '/config' },
    true,
    draft,
  );
  expect(chooseDraft).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
