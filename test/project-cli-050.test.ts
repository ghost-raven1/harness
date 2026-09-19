import { beforeEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import type { CliContext } from '../src/interfaces/types.js';
import type { TaskDraft } from '../src/sessions/drafts.js';
import { chooseDraft } from '../src/interfaces/guided/task-drafts.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { prepareProject } from '../src/interfaces/guided/project-work/setup.js';
import { editProjectPlan } from '../src/interfaces/guided/project-work/editor.js';
import { outputPageText } from '../src/interfaces/guided/project-work/reports.js';
import { comparisonText } from '../src/interfaces/guided/project-work/plan-history.js';
import { chooseProjectSet } from '../src/interfaces/guided/project-work/form-input.js';
import { freshStage } from '../src/interfaces/guided/project-work/stage-editor.js';
import { ReaderState } from '../src/interfaces/guided/text-reader.js';
import { registerProjectCommands } from '../src/interfaces/commands/projects.js';
import { projectFixture } from './project-ui-fixture.js';
import { temporary } from './helpers.js';
import { ApplicationError } from '../src/shared/application-error.js';

vi.mock('../src/interfaces/guided/task-drafts.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/task-drafts.js')>()),
  chooseDraft: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/guided/project-work/detail.js', () => ({ inspectProject: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

/** Готовая форма остаётся редактируемой до отдельного подтверждения. */
function creationDraft(): TaskDraft {
  return {
    schemaVersion: 1,
    id: 'f7cd94ac-a8ce-4b3e-8c52-9df922d28156',
    scope: { workspace: '/workspace', profile: 'test', purpose: 'project.create' },
    requestKey: 'create-once',
    revision: 1,
    text: 'Проверить сайт',
    payload: {
      kind: 'project.create',
      title: 'Мой сайт',
      goal: 'Проверить сайт',
      workspace: '/workspace',
      profile: 'test',
    },
    state: 'editing',
    updatedAt: '2026-09-19',
  };
}

it('отмена параметров сохраняет черновик и не вызывает ни создание проекта, ни модель', async () => {
  vi.mocked(chooseDraft).mockResolvedValue(creationDraft());
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('Мой сайт');
    return 'back';
  });
  const request = vi.fn();
  await prepareProject({ request } as unknown as CliContext, {
    workspace: '/workspace',
    profile: 'test',
    configFile: '/config',
  });
  expect(request).not.toHaveBeenCalled();
});

it('после потери ответа повтор использует сохранённый payload и тот же ключ планирования', async () => {
  let draft = creationDraft();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'drafts.get') return draft;
    if (method === 'drafts.update') {
      draft = { ...draft, ...params, revision: draft.revision + 1 } as TaskDraft;
      return draft;
    }
    if (method === 'projects.create') return projectFixture({ status: 'draft' });
    if (method === 'projects.plan') throw new Error('Connection lost');
    throw new Error(method);
  });
  vi.mocked(chooseDraft).mockImplementation(async () => draft);
  vi.mocked(liveSelect).mockResolvedValue('submit');
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    expect((await options.load()).available).toBe(true);
    return true;
  });
  const context = { request } as unknown as CliContext;
  const preferences = { workspace: '/workspace', profile: 'test', configFile: '/config' };
  await expect(prepareProject(context, preferences)).rejects.toThrow('Connection lost');
  await expect(prepareProject(context, preferences)).rejects.toThrow('Connection lost');
  const calls = request.mock.calls.filter(([method]) => method === 'projects.plan');
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]?.[1]?.requestKey).toBe('create-once:plan');
  expect(draft.state).toBe('pending');
  expect(request.mock.calls.some(([method]) => method === 'drafts.remove')).toBe(false);
});

it('второе окно блокирует сохранение редакции, но оставляет сравнение и весь введённый план', async () => {
  const view = projectFixture();
  const { version: _version, ...plan } = view.plan!;
  const draft = {
    ...creationDraft(),
    scope: {
      workspace: view.workspace,
      profile: view.profile,
      projectId: view.projectId,
      purpose: 'project.edit' as const,
    },
    expectedProjectRevision: view.revision,
    payload: { kind: 'project.edit' as const, plan },
  };
  vi.mocked(chooseDraft).mockResolvedValue(draft);
  const request = vi.fn().mockResolvedValue({ ...view, revision: view.revision + 1 });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.summary).toContain('Ваш ввод сохранён');
    expect(menu.options.some((item) => item.value === 'save')).toBe(false);
    expect(menu.options.some((item) => item.value === 'compare')).toBe(true);
    return 'back';
  });
  await editProjectPlan({ request } as unknown as CliContext, view);
  expect(request.mock.calls.every(([method]) => method === 'projects.detail')).toBe(true);
  expect(draft.payload.plan).toEqual(plan);
});

it('копирование создаёт новые ID этапа и каждой проверки, сохраняя буквальные argv', () => {
  const view = projectFixture();
  const original = view.plan!.stages[0]!;
  const copy = freshStage(view, original);
  expect(copy.id).not.toBe(original.id);
  if (copy.verification.kind !== 'commands' || original.verification.kind !== 'commands')
    throw new Error('Fixture');
  expect(copy.verification.checks[0]?.id).not.toBe(original.verification.checks[0]?.id);
  expect(copy.verification.checks[0]?.args).toEqual(['test', '--', 'file with space']);
});

it.each([48, 80])(
  'страницы вывода и сравнение читаемы в %i×24 и очищают управляющие коды',
  (width) => {
    const output = outputPageText({
      projectId: 'p',
      reportId: 'r',
      checkId: 'c',
      stream: 'stderr',
      state: 'completed',
      evidence: 'available',
      text: 'x'.repeat(1600) + '\nОшибка после 1500\u001b[2J\nОшибка сохранена',
      offset: 0,
      totalCharacters: 1700,
      truncated: true,
      complete: false,
    });
    expect(output).toContain('Ошибка после 1500');
    expect(output).toContain('обрезал');
    const view = projectFixture();
    const diff = comparisonText({
      projectId: view.projectId,
      revision: 1,
      before: view.plan,
      after: view.plan!,
      fromVersion: 1,
      toVersion: 2,
      basis: 'explicit',
      changes: [
        {
          kind: 'changed',
          field: 'args',
          stageId: 'implement',
          checkId: 'test',
          before: ['--x', ''],
          after: ['--x', 'literal space'],
        },
      ],
    });
    expect(diff).toContain('"literal space"');
    const reader = new ReaderState({
      tabs: [
        { id: 'output', label: 'stderr', text: output },
        { id: 'diff', label: 'Изменения', text: diff },
      ],
      actionLabel: 'страницы',
    });
    reader.frame('Проверка', width - 1, 24);
    reader.key({ name: 'end' });
    const frame = stripAnsi(reader.frame('Проверка', width - 1, 24));
    expect(frame).toContain('Ошибка сохранена');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThan(width);
  },
);

it('CLI validate-plan сохраняет ошибочный черновик для общей проверки сервера, включая пустые аргументы', async () => {
  const file = join(await temporary(), 'plan.json');
  const plan = {
    stages: [
      {
        verification: { kind: 'commands', checks: [{ command: '', args: ['', 'literal space'] }] },
      },
    ],
  };
  await writeFile(file, JSON.stringify(plan));
  const request = vi.fn().mockResolvedValue({ valid: false, issues: [] });
  const context = { request, output: vi.fn() } as unknown as CliContext;
  const command = new Command();
  registerProjectCommands(command, context);
  await command.parseAsync([
    'node',
    'harness',
    'projects',
    'validate-plan',
    'project',
    '--file',
    file,
  ]);
  expect(request).toHaveBeenCalledExactlyOnceWith('projects.validatePlan', {
    projectId: 'project',
    expectedRevision: undefined,
    plan,
  });
});

it('живой список сохраняет фильтр внимания и открывает интерфейс 0.5 после выбора', async () => {
  const { browseProjects } = await import('../src/interfaces/guided/project-work/list.js');
  const { inspectProject } = await import('../src/interfaces/guided/project-work/detail.js');
  const view = projectFixture();
  const request = vi.fn(async (method: string) =>
    method === 'system.info'
      ? { capabilities: ['projects-review-v1'] }
      : { items: [view], total: 1, page: 0, pages: 1, attentionCount: 1 },
  );
  let index = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    if (index++ === 0) {
      expect(menu.options.some((item) => item.value === 'attention')).toBe(true);
      return 'attention';
    }
    expect(menu.options).toContainEqual({ value: 'attention', label: 'Все проекты', hint: '1' });
    return index === 2 ? 'open:' + view.projectId : 'back';
  });
  await browseProjects({ request } as unknown as CliContext, {
    workspace: '/workspace',
    profile: 'test',
    configFile: '/config',
  });
  expect(request).toHaveBeenCalledWith(
    'projects.list',
    expect.objectContaining({ attentionOnly: true }),
  );
  expect(inspectProject).toHaveBeenCalledExactlyOnceWith(expect.anything(), view.projectId, true);
});

it('отказ уже отправленной редакции открывает сравнение и сохраняет весь неизменный запрос', async () => {
  const view = projectFixture();
  const { version: _version, ...plan } = view.plan!;
  const draft = {
    ...creationDraft(),
    state: 'pending' as const,
    scope: {
      workspace: view.workspace,
      profile: view.profile,
      projectId: view.projectId,
      purpose: 'project.edit' as const,
    },
    expectedProjectRevision: view.revision,
    payload: { kind: 'project.edit' as const, plan },
  };
  vi.mocked(chooseDraft).mockResolvedValue(draft);
  const request = vi.fn(async (method: string) => {
    if (method === 'projects.editPlan')
      throw new ApplicationError('PROJECT_CONFLICT', 'Проект изменился');
    if (method === 'projects.detail') return { ...view, revision: view.revision + 1 };
    throw new Error(method);
  });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const menu = await options.load();
    expect(menu.options.some((item) => item.value === 'compare')).toBe(true);
    expect(menu.options.some((item) => item.value === 'copy')).toBe(true);
    return 'back';
  });
  await editProjectPlan({ request } as unknown as CliContext, view);
  expect(request.mock.calls.filter(([method]) => method === 'projects.editPlan')).toHaveLength(1);
  expect(request.mock.calls.some(([method]) => method.startsWith('drafts.'))).toBe(false);
  expect(draft.payload.plan).toEqual(plan);
});

it.each(['removed-stage', 'unavailable-tool'])(
  'форма позволяет явно убрать недоступный выбранный пункт %s',
  async (missing) => {
    const save = vi.fn();
    let step = 0;
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      const menu = await options.load();
      if (step++ === 0) {
        expect(menu.options.find((item) => item.value === missing)?.label).toContain(
          'Недоступно или удалено',
        );
        return missing;
      }
      expect(menu.options.some((item) => item.value === missing)).toBe(false);
      return '__done';
    });
    await chooseProjectSet(
      'Зависимости',
      [{ value: 'existing', label: 'Существующий этап' }],
      ['existing', missing],
      save,
    );
    expect(save).toHaveBeenCalledExactlyOnceWith(['existing']);
  },
);

it('копия максимально длинного названия остаётся допустимым полем формы', () => {
  const view = projectFixture();
  const copied = freshStage(view, { ...view.plan!.stages[0]!, title: 'я'.repeat(500) });
  expect(copied.title).toHaveLength(500);
  expect(copied.title.endsWith(' · копия')).toBe(true);
});
