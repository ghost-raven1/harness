import { afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './purge-fixture.js';
import { id } from '../src/shared/primitives.js';
import { mutation } from './project-helpers.js';

afterEach(() => vi.restoreAllMocks());

/** Экспорт чернового проекта не обращается к модели и принадлежит управляемому каталогу. */
async function exported() {
  const item = await fixture();
  let project = await item.app.projects.create({
    title: 'Экспорт',
    goal: 'Сохранить результат',
    workspace: item.workspace,
    profile: 'test',
    requestKey: id(),
  });
  project = await item.app.projects.cancel(mutation(project));
  const input = { projectId: project.projectId, expectedRevision: project.revision };
  const preview = await item.app.projectExports.preview(input);
  const report = await item.app.projectExports.export({
    ...input,
    previewToken: preview.previewToken,
    requestKey: id(),
  });
  const copy = join(item.workspace, 'копия-отчёта.md');
  await writeFile(copy, await readFile(report.path));
  return { ...item, project, report, copy };
}

it.each(['tasks', 'learning', 'all'] as const)(
  '%s: сброс учитывает экспорт проекта и сохраняет пользовательскую копию',
  async (scope) => {
    const item = await exported();
    const forget = vi.spyOn(item.app.projectEvidence, 'forget');
    const preview = await item.app.reset.preview(scope);
    expect(preview.available).toBe(true);
    expect(preview.exports).toBe(scope === 'all' ? 2 : 1);
    await item.app.reset.reset(scope, preview.previewToken);
    if (scope === 'learning') {
      expect(await readFile(item.report.path, 'utf8')).toContain('Сохранить результат');
      expect(forget).not.toHaveBeenCalled();
    } else {
      await expect(readFile(item.report.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(forget).toHaveBeenCalledWith(item.project.projectId);
    }
    expect(await readFile(item.copy, 'utf8')).toContain('Сохранить результат');
  },
);

it('удаление проекта охватывает отчёт, квитанцию и кэш, не удаляя внешнюю копию', async () => {
  const item = await exported();
  const forget = vi.spyOn(item.app.projectEvidence, 'forget');
  const preview = await item.app.projects.purgePreview({ projectId: item.project.projectId });
  await item.app.projects.purge({ ...mutation(item.project), previewToken: preview.previewToken });
  await expect(readFile(item.report.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(forget).toHaveBeenCalledWith(item.project.projectId);
  expect(await readFile(item.copy, 'utf8')).toContain('Сохранить результат');
});
