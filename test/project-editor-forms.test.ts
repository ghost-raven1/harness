import { beforeEach, expect, it, vi } from 'vitest';
import { editStageVerification } from '../src/interfaces/guided/project-work/check-editor.js';
import { editStage } from '../src/interfaces/guided/project-work/stage-editor.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { readTaskInput } from '../src/interfaces/guided/task-input.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { projectFixture } from './project-ui-fixture.js';

vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
vi.mock('../src/interfaces/guided/task-input.js', () => ({ readTaskInput: vi.fn() }));
vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each(['', 'literal space', '"$HOME"\n$(command)'])(
  'редактор аргумента сохраняет буквальный argv: %j',
  async (argument) => {
    const save = vi.fn();
    vi.mocked(liveSelect)
      .mockResolvedValueOnce('check:check')
      .mockResolvedValueOnce('arg:0')
      .mockResolvedValueOnce('back')
      .mockResolvedValueOnce('back');
    vi.mocked(readTaskInput).mockImplementation(async (options) => {
      expect(options.allowEmpty).toBe(true);
      await options.save(argument);
      return argument;
    });
    await editStageVerification(
      {
        kind: 'commands',
        checks: [{ id: 'check', title: 'Тест', command: 'node', args: ['old'] }],
      },
      save,
    );
    expect(save).toHaveBeenCalledExactlyOnceWith({
      kind: 'commands',
      checks: [{ id: 'check', title: 'Тест', command: 'node', args: [argument] }],
    });
  },
);

it('завершённый этап доступен в форме только для чтения', async () => {
  const view = projectFixture();
  const plan = view.plan!;
  const stage = plan.stages[0]!;
  view.stages[0]!.status = 'completed';
  const save = vi.fn();
  await editStage(view, stage, () => plan, save);
  expect(readText).toHaveBeenCalledOnce();
  expect(liveSelect).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
