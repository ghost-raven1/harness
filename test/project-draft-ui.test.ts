import { beforeEach, expect, it, vi } from 'vitest';
import { ApplicationError } from '../src/shared/application-error.js';
import type { TaskDraft } from '../src/sessions/drafts.js';
import type { CliContext } from '../src/interfaces/types.js';
import { chooseDraft } from '../src/interfaces/guided/task-drafts.js';
import { readTaskInput } from '../src/interfaces/guided/task-input.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { projectDraft, submitProjectDraft } from '../src/interfaces/guided/project-work/drafts.js';
import { projectFixture } from './project-ui-fixture.js';

vi.mock('../src/interfaces/guided/task-drafts.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/task-drafts.js')>()),
  chooseDraft: vi.fn(),
}));
vi.mock('../src/interfaces/guided/task-input.js', () => ({ readTaskInput: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

/** Повтор отправки воспроизводит сохранённые реквизиты, а не текущую карточку проекта. */
function draftFixture(): TaskDraft {
  return {
    schemaVersion: 1,
    id: 'a57d92ea-f9cf-4f70-8a9c-345a8a704cd3',
    scope: {
      workspace: '/workspace',
      profile: 'test',
      purpose: 'project.plan',
      projectId: projectFixture().projectId,
    },
    requestKey: 'same-send',
    revision: 1,
    expectedProjectRevision: 2,
    text: 'Изменить план',
    state: 'pending',
    updatedAt: '2026-09-19',
  };
}

it('восстановление pending оставляет исходные ключ и ревизию без повторного ввода', async () => {
  const draft = draftFixture();
  vi.mocked(chooseDraft).mockResolvedValue(draft);
  const request = vi.fn();
  expect(
    await projectDraft(
      { request } as unknown as CliContext,
      draft.scope,
      'План',
      projectFixture({ revision: 99 }),
    ),
  ).toBe(draft);
  expect(readTaskInput).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it('обрыв связи сохраняет pending без нового ключа и без удаления', async () => {
  const request = vi.fn();
  const send = vi.fn().mockRejectedValue(new Error('Connection lost'));
  await expect(
    submitProjectDraft({ request } as unknown as CliContext, draftFixture(), send),
  ).rejects.toThrow('Connection lost');
  expect(send).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  expect(liveSelect).not.toHaveBeenCalled();
});

it.each(['back', 'copy'])(
  'подтверждённый конфликт: выбор %s не отправляет новый запрос автоматически',
  async (choice) => {
    const request = vi.fn().mockResolvedValue(projectFixture());
    vi.mocked(liveSelect).mockImplementation(async (options) => {
      const menu = await options.load();
      expect(menu.options[0]?.value).toBe('back');
      return choice;
    });
    const send = vi
      .fn()
      .mockRejectedValue(new ApplicationError('PROJECT_CONFLICT', 'Проект изменился'));
    const draft = draftFixture();
    await expect(
      submitProjectDraft({ request } as unknown as CliContext, draft, send),
    ).rejects.toThrow('Проект изменился');
    expect(send).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith('drafts.remove', expect.anything());
    if (choice === 'copy')
      expect(request).toHaveBeenCalledWith('drafts.create', {
        scope: draft.scope,
        text: draft.text,
      });
    else expect(request).toHaveBeenCalledTimes(1);
  },
);

it('только подтверждённая отправка удаляет соответствующую ревизию черновика', async () => {
  const request = vi.fn();
  const draft = draftFixture();
  await submitProjectDraft({ request } as unknown as CliContext, draft, async () =>
    projectFixture(),
  );
  expect(request).toHaveBeenCalledExactlyOnceWith('drafts.remove', {
    id: draft.id,
    sessionId: undefined,
    expectedRevision: 1,
  });
});
