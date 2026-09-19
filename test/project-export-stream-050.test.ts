import { expect, it, vi } from 'vitest';
import { exportChunks, exportDocument } from '../src/application/project-export-format.js';
import { EvidenceCache } from '../src/projects/evidence-cache.js';
import { ProjectEvidenceService } from '../src/projects/evidence.js';
import { ProjectWorkspace } from '../src/projects/workspace.js';
import { draftProject, projectHarness } from './project-helpers.js';

it('потоковый экспорт запрашивает следующий большой журнал только после потребления предыдущего', async () => {
  const app = await projectHarness();
  const draft = await draftProject(app);
  const project = await app.projectStore.get(draft.projectId);
  const evidence = new ProjectEvidenceService({
    projects: app.projectStore,
    sessions: app.sessions,
    workspace: new ProjectWorkspace(app.sessions.directory),
  });
  const review = await evidence.review({ projectId: project.id });
  const document = exportDocument(project, review);
  document.reports = [
    {
      id: 'report',
      phase: 'final',
      attempt: 0,
      at: '',
      status: 'passed',
      workspaceRevision: '',
      current: true,
      checks: Array.from({ length: 20 }, (_, index) => ({
        id: String(index),
        sourceId: 'tests',
        title: 'Тест',
        command: 'node',
        args: [],
        state: 'completed',
        evidence: 'available',
        exitCode: 0,
      })),
    },
  ];
  const large = 'я'.repeat(512000);
  const read = vi.fn(async () => ({
    stdout: large,
    stderr: large,
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  }));
  const stream = exportChunks(document, 'json', read);
  await stream.next();
  await stream.next();
  expect(read).not.toHaveBeenCalled();
  const first = await stream.next();
  expect(first.done).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(first.value!).log.stdout).toBe(large);
  expect(document.reports[0]!.checks[0]).not.toHaveProperty('log');
  await stream.return(undefined);
  expect(read).toHaveBeenCalledTimes(1);
});

it('удаление во время чтения не возвращает данные в кэш после очистки', async () => {
  const cache = new EvidenceCache();
  let finish!: (value: string) => void;
  const generation = cache.revision();
  const reading = cache.get(
    'removed',
    'result',
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  cache.forget('removed');
  finish(JSON.stringify({ stdout: 'result', stderr: '', exitCode: 0 }));
  await reading;
  expect(cache.stats().bytes).toBe(0);
  const lateSource = vi.fn(async () => JSON.stringify({ stdout: 'late', stderr: '', exitCode: 0 }));
  await expect(cache.get('removed', 'late', lateSource, generation)).rejects.toThrow('удалено');
  expect(lateSource).not.toHaveBeenCalled();
});
