import { beforeEach, expect, it, vi } from 'vitest';
import type { CliContext } from '../src/interfaces/types.js';
import type { EvidenceCheck, EvidenceReport } from '../src/projects/read-schema.js';
import { inspectProjectCheck } from '../src/interfaces/guided/project-work/reports.js';
import { readText } from '../src/interfaces/guided/text-reader.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';

vi.mock('../src/interfaces/guided/text-reader.js', () => ({ readText: vi.fn() }));
vi.mock('../src/interfaces/guided/live-select.js', () => ({ liveSelect: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const check: EvidenceCheck = {
  id: 'check',
  sourceId: 'criterion',
  title: 'Тест',
  command: 'node',
  args: ['--test', 'literal space', ''],
  state: 'running',
  evidence: 'pending',
};
const report: EvidenceReport = {
  id: 'pending-run',
  phase: 'stage',
  stageId: 'stage',
  attempt: 1,
  runId: 'run',
  at: '2026-09-19',
  status: 'unknown',
  workspaceRevision: 'digest',
  checks: [check],
  current: true,
};

it('открытая выполняющаяся проверка получает код завершения из живой страницы доказательства', async () => {
  let completed = false;
  const request = vi.fn(
    async (_method: string, params: { stream: 'stdout' | 'stderr'; offset: number }) => ({
      projectId: 'project',
      reportId: report.id,
      checkId: check.id,
      ...params,
      state: completed ? 'completed' : 'running',
      evidence: completed ? 'available' : 'pending',
      exitCode: completed ? 7 : undefined,
      text: completed ? 'Ошибка теста' : '',
      totalCharacters: completed ? 12 : 0,
      truncated: false,
      complete: completed,
    }),
  );
  vi.mocked(readText).mockImplementation(async (_title, tabs, options) => {
    expect(tabs[0]?.text).toContain('ещё не получен');
    completed = true;
    const next = await options?.load?.();
    expect(next?.tabs[0]?.text).toContain('Код завершения: 7');
    expect(next?.tabs[0]?.text).toContain('3: ""');
    expect(next?.tabs[2]?.text).toContain('Ошибка теста');
    return 'back';
  });
  await inspectProjectCheck({ request } as unknown as CliContext, 'project', report, check);
  expect(request.mock.calls.every(([method]) => method === 'projects.checkOutput')).toBe(true);
});

it('переход к следующей странице stdout не загружает весь артефакт и не сдвигает stderr', async () => {
  const request = vi.fn(
    async (_method: string, params: { stream: 'stdout' | 'stderr'; offset: number }) => ({
      projectId: 'project',
      reportId: report.id,
      checkId: check.id,
      ...params,
      state: 'completed',
      evidence: 'available',
      exitCode: 0,
      text: params.stream === 'stderr' ? '' : params.offset ? 'Конец вывода' : 'x'.repeat(16384),
      nextOffset: params.stream === 'stdout' && !params.offset ? 16384 : undefined,
      totalCharacters: params.stream === 'stdout' ? 16396 : 0,
      truncated: false,
      complete: true,
    }),
  );
  vi.mocked(readText)
    .mockResolvedValueOnce('action')
    .mockImplementationOnce(async (_title, tabs) => {
      expect(tabs[1]?.text).toContain('Конец вывода');
      return 'back';
    });
  vi.mocked(liveSelect).mockImplementation(async (options) => {
    expect((await options.load()).options.some((item) => item.value === 'next:stdout')).toBe(true);
    return 'next:stdout';
  });
  await inspectProjectCheck({ request } as unknown as CliContext, 'project', report, check);
  expect(request.mock.calls.map(([, params]) => [params.stream, params.offset])).toEqual([
    ['stdout', 0],
    ['stderr', 0],
    ['stdout', 16384],
    ['stderr', 0],
  ]);
});
