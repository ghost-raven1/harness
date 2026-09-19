import { beforeEach, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { ReaderState, readText } from '../src/interfaces/guided/text-reader.js';
import { liveSelect, menuFrame } from '../src/interfaces/guided/live-select.js';
import { liveConfirm } from '../src/interfaces/guided/live-confirm.js';
import { confirmProject } from '../src/interfaces/guided/project-work/confirm.js';
import { manualProjectCheck } from '../src/interfaces/guided/project-work/checks.js';
import { inspectProject, projectReader } from '../src/interfaces/guided/project-work/detail.js';
import {
  planText,
  projectSummary,
  projectTabs,
} from '../src/interfaces/guided/project-work/format.js';
import { projectFixture } from './project-ui-fixture.js';
import { projectAction, resumeProject } from '../src/interfaces/guided/project-work/actions.js';
import { ApplicationError } from '../src/shared/application-error.js';
import type { CliContext } from '../src/interfaces/types.js';
import { decideApprovals } from '../src/interfaces/ui.js';

vi.mock('../src/interfaces/guided/live-select.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/live-select.js')>()),
  liveSelect: vi.fn(),
}));
vi.mock('../src/interfaces/guided/live-confirm.js', () => ({ liveConfirm: vi.fn() }));
vi.mock('../src/interfaces/ui.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/ui.js')>()),
  decideApprovals: vi.fn(),
}));
vi.mock('../src/interfaces/guided/text-reader.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/text-reader.js')>()),
  readText: vi.fn(),
}));
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  text: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

it('карточка ожидания ведёт к разрешениям текущего запуска и обновляется после решения', async () => {
  let view = projectFixture({
    status: 'running',
    currentRunId: 'baseline-run',
    pendingApprovals: 1,
    reasonCode: 'APPROVAL_REQUIRED',
    allowedActions: ['pause', 'cancel'],
  });
  const request = vi.fn(async (_method: string) => view);
  vi.mocked(readText).mockImplementation(async (_title, tabs, options) => {
    expect(options?.subtitle).toContain('Ждёт разрешения: 1');
    expect(tabs[0]?.text).toContain('Ждёт разрешения: 1');
    return 'action';
  });
  vi.mocked(decideApprovals).mockImplementation(async () => {
    view = { ...view, pendingApprovals: 0, reasonCode: undefined };
  });
  let menu = 0;
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    const state = await options.load();
    if (menu++ === 0) {
      expect(state.summary).toContain('Ждёт разрешения: 1');
      expect(state.options).toContainEqual({ value: 'approvals', label: 'Рассмотреть разрешения' });
      return 'approvals';
    }
    expect(state.summary).toContain('В работе');
    expect(state.options.some((option) => option.value === 'approvals')).toBe(false);
    return 'back';
  });
  await inspectProject(
    { request, directory: () => '/state' } as unknown as CliContext,
    view.projectId,
  );
  expect(decideApprovals).toHaveBeenCalledExactlyOnceWith('/state', 'baseline-run');
  expect(request.mock.calls.every(([method]) => method === 'projects.detail')).toBe(true);
});

it('исчезнувшее разрешение не открывает общий список чужих проектов', async () => {
  const view = projectFixture({ status: 'running', pendingApprovals: 1, currentRunId: 'old-run' });
  const request = vi
    .fn()
    .mockResolvedValue({ ...view, currentRunId: undefined, pendingApprovals: 0 });
  await projectAction({ request } as unknown as CliContext, view, 'approvals');
  expect(decideApprovals).not.toHaveBeenCalled();
});

it('план показывает точные аргументы и ручные проверки до принятия', () => {
  const view = projectFixture();
  const plan = view.plan!;
  plan.stages.push({
    ...plan.stages[0]!,
    id: 'manual',
    title: 'Проверка глазами',
    dependsOn: ['implement'],
    verification: { kind: 'manual', instructions: 'Открыть страницу в маленьком окне' },
  });
  const text = planText(plan, view.roles);
  expect(text).toContain('npm test -- "file with space"');
  expect(text).toContain('Разработчик');
  expect(text).toContain('После этапов: Страница ошибок');
  expect(text).toContain('Открыть страницу в маленьком окне');
});

it.each([48, 80])('карточка и меню укладываются в %i×24 без скрытых клавиш', (width) => {
  const view = projectFixture();
  const reader = new ReaderState({
    tabs: projectTabs(view),
    subtitle: projectSummary(view),
    actionLabel: 'Действия',
  });
  for (let index = 0; index < 4; index++) {
    const frame = stripAnsi(reader.frame('Проект', width - 1, 24));
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThan(width);
    expect(frame).toContain('Esc');
    reader.key({ name: 'tab' });
  }
  const frame = stripAnsi(
    menuFrame(
      'Проекты',
      {
        summary: projectSummary(view),
        message: 'Что дальше?',
        options: [
          { value: 'accept', label: 'Принять план и начать выполнение' },
          { value: 'back', label: '← К списку проектов' },
        ],
      },
      'accept',
      width - 1,
      24,
    ),
  );
  expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThan(width);
});

it('изменение ревизии вторым окном отзывает подтверждение плана', async () => {
  const view = projectFixture();
  const request = vi
    .fn()
    .mockResolvedValueOnce(view)
    .mockResolvedValueOnce({ ...view, revision: view.revision + 1 });
  vi.mocked(liveConfirm).mockImplementation(async (options) => {
    expect(await options.load()).toMatchObject({ available: true });
    expect(await options.load()).toMatchObject({ available: false });
    return undefined;
  });
  expect(
    await confirmProject(
      { request } as unknown as CliContext,
      view,
      'acceptPlan',
      'Принять?',
      'План',
    ),
  ).toBe(false);
  expect(request.mock.calls.every(([method]) => method === 'projects.detail')).toBe(true);
});

it.each([false, true])(
  'внешние изменения после паузы принимаются только после отдельного решения: %s',
  async (accepted) => {
    const initial = projectFixture({ status: 'paused', revision: 4, allowedActions: ['resume'] });
    const changed = {
      ...initial,
      revision: 5,
      reasonCode: 'PROJECT_CHANGED',
      externalChanges: [{ path: 'changed.txt', kind: 'modified' as const }],
    };
    const request = vi.fn(async (method, input) => {
      if (method === 'projects.resume' && !input.acceptChanges)
        throw new ApplicationError('PROJECT_CHANGED', 'Файлы изменились');
      return changed;
    });
    vi.mocked(liveConfirm).mockImplementation(async (options) => {
      expect((await options.load()).available).toBe(true);
      expect(options.body).toContain('Файлы изменились');
      expect(options.body).toContain('~ changed.txt');
      return accepted;
    });
    await resumeProject({ request } as unknown as CliContext, initial);
    const mutations = request.mock.calls.filter(([method]) => method === 'projects.resume');
    expect(mutations).toHaveLength(accepted ? 2 : 1);
    if (accepted) {
      expect(mutations[1]?.[1]).toMatchObject({ expectedRevision: 5, acceptChanges: true });
      expect(mutations[1]?.[1].requestKey).not.toBe(mutations[0]?.[1].requestKey);
    }
  },
);

it.each(['manual', 'completed'] as const)(
  'ручная проверка %s использует свежий resultRevision, не прежнее подтверждение',
  async (status) => {
    const view = projectFixture({
      status: 'paused',
      resultRevision: 'current-files',
      reasonCode: status === 'manual' ? 'MANUAL_CHECK' : 'FINAL_MANUAL_CHECK',
      allowedActions: ['manualCheck'],
      stages: [
        {
          stageId: 'implement',
          title: 'Страница ошибок',
          status,
          attempt: 0,
          manualRevision: status === 'manual' ? undefined : 'old-files',
        },
      ],
    });
    view.plan!.stages[0]!.verification = { kind: 'manual', instructions: 'Открыть страницу' };
    const request = vi.fn().mockResolvedValue(view);
    let menu = 0;
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      const state = await options.load();
      if (menu++ === 0) {
        expect(state.options).toEqual(
          expect.arrayContaining([expect.objectContaining({ value: 'implement' })]),
        );
        return 'implement';
      }
      return 'passed';
    });
    vi.mocked(prompts.text).mockResolvedValue('Проверил страницу');
    vi.mocked(readText).mockImplementation(async (_title, tabs, options) => {
      expect(tabs[0]?.text).toContain('Открыть страницу');
      expect((await options?.load?.())?.actionLabel).toBe('Указать результат');
      return 'action';
    });
    vi.mocked(liveConfirm).mockImplementation(async (options) => {
      expect((await options.load()).available).toBe(true);
      return true;
    });
    await manualProjectCheck({ request } as unknown as CliContext, view);
    expect(request).toHaveBeenLastCalledWith(
      'projects.manualCheck',
      expect.objectContaining({
        stageId: 'implement',
        expectedResultRevision: 'current-files',
        expectedRevision: 3,
        outcome: 'passed',
      }),
    );
  },
);

it('живой журнал идёт по курсору, не дублирует события и ограничивает память', async () => {
  const request = vi.fn(async (_method, input) => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      seq: input.cursor + index + 1,
      at: '2026-09-19',
      type: 'changed',
      message: String(input.cursor + index + 1),
    }));
    return projectFixture({ events: { items, cursor: items.at(-1)!.seq, hasMore: true } });
  });
  const load = projectReader({ request } as unknown as CliContext, 'p');
  await load();
  await load();
  const view = await load();
  expect(request.mock.calls.map(([, input]) => input.cursor)).toEqual([0, 100, 200]);
  expect(view.events.items).toHaveLength(200);
  expect(view.events.items[0]?.seq).toBe(101);
  expect(view.events.items.at(-1)?.seq).toBe(300);
});
