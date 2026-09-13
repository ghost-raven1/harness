import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import * as prompts from '@clack/prompts';
import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';
import { browseKnowledge, queryKnowledge } from '../src/interfaces/guided/knowledge.js';
import {
  knowledgeTabs,
  lessonMarkdown,
  saveLesson,
  releaseText,
} from '../src/interfaces/guided/knowledge-format.js';
import { readText, readerFrame } from '../src/interfaces/guided/text-reader.js';
import { dispatch } from '../src/interfaces/routes.js';
import type { Application } from '../src/interfaces/application.js';
import type {
  LearningInspectView,
  LearningStatusView,
  CliContext,
} from '../src/interfaces/types.js';
import type { LearningState } from '../src/learning/types.js';
import { temporary } from './helpers.js';

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  note: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock('../src/interfaces/guided/text-reader.js', async (original) => ({
  ...(await original<typeof import('../src/interfaces/guided/text-reader.js')>()),
  readText: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

function detail(): LearningInspectView {
  const runId = randomUUID();
  return {
    candidate: {
      id: randomUUID(),
      sourceRunId: runId,
      workspace: '/projects/Японский проект',
      role: 'coordinator',
      profile: 'codex',
      title: 'Проверка документации',
      lesson: 'Сверяйте команды запуска с README.',
      appliesWhen: 'При изучении проекта.',
      evidenceIds: ['proof'],
      status: 'published',
      fingerprint: 'fixture',
    },
    evidence: [
      {
        id: 'proof',
        runId,
        agentId: 'coordinator',
        role: 'coordinator',
        kind: 'tool',
        content: JSON.stringify({ tool: 'fs.read', result: 'Проверенный исходный результат' }),
        verified: true,
      },
    ],
    report: {
      candidateId: '',
      baselineVersion: 'baseline',
      suiteHash: 'control-fixture',
      passed: true,
      results: [
        {
          caseId: 'holdout',
          variant: 'candidate',
          repetition: 3,
          passed: true,
          detail: 'Контроль пройден',
        },
      ],
    },
  };
}
function status(count = 17): LearningStatusView {
  const candidates = Array.from({ length: count }, (_, index) => ({
    ...detail().candidate,
    title: 'Урок ' + index,
    status: 'published' as const,
  }));
  return {
    activeVersion: 'release-current',
    activeCandidateIds: candidates.slice(0, 2).map((item) => item.id),
    releases: [{ id: 'baseline', createdAt: new Date(0).toISOString(), candidateIds: [] }],
    enabled: true,
    paused: false,
    dailyLimit: null,
    daily: { date: '', tokens: 0 },
    jobs: [],
    candidates,
  };
}

it('пагинация показывает все уроки, включая опубликованные вне активного выпуска', () => {
  const state = status();
  const pages = [0, 1, 2].flatMap((page) => queryKnowledge(state, '', false, page).items);
  expect(new Set(pages.map((item) => item.id)).size).toBe(17);
  expect(queryKnowledge(state, '', true).total).toBe(2);
  expect(queryKnowledge(state, 'ЯПОНСКИЙ').total).toBe(17);
  expect(queryKnowledge(state, 'урок 16').items[0]?.title).toBe('Урок 16');
  expect(queryKnowledge(state, 'нет совпадений', false, 100)).toMatchObject({
    items: [],
    page: 0,
    pages: 1,
    total: 0,
  });
});

it('вкладки сохраняют полный урок, доказательства и все повторы оценки', () => {
  const value = detail();
  value.evidence[0]!.content = 'Начало\n' + 'Проверка\n'.repeat(12000) + 'Последний источник';
  value.report!.results = Array.from({ length: 6 }, (_, index) => ({
    caseId: 'case',
    variant: index < 3 ? 'baseline' : 'candidate',
    repetition: (index % 3) + 1,
    passed: true,
    detail: 'Проверка ' + index,
  }));
  const tabs = knowledgeTabs(value, false);
  expect(tabs[0]!.text).toContain('Сейчас не применяется. Опубликован');
  expect(tabs[1]!.text).toContain('Последний источник');
  expect(tabs[2]!.text).toContain('Проверка 5');
  expect(knowledgeTabs({ ...value, evidence: [], report: undefined }, true)[2]!.text).toContain(
    'ещё не проводилась',
  );
});

it.each([
  [47, 24],
  [89, 45],
])('полнотекстовый экран %s×%s сохраняет рамку и доступ к концу', (width, height) => {
  const tabs = [
    {
      id: 'lesson',
      label: 'Урок',
      text: '\u001b[2JНачало\n' + '日本語 🐦 Проверка длинной строки\n'.repeat(80) + 'Конец',
    },
    { id: 'proof', label: 'Доказательства', text: 'Другой источник' },
  ];
  const first = readerFrame('Очень длинное название '.repeat(6), tabs, 0, 0, width, height, {
    actionLabel: 'действия с уроком',
  });
  expect(first.frame).toContain('Начало');
  expect(first.frame).not.toContain('\u001b[2J');
  expect(first.frame.split('\n')).toHaveLength(height - 1);
  expect(
    first.frame.split('\n').every((line) => stringWidth(stripVTControlCharacters(line)) <= width),
  ).toBe(true);
  expect(first.frame).toContain('Esc — назад');
  expect(first.frame).toContain('Enter — действия с уроком');
  expect(readerFrame('Урок', tabs, 0, first.maximum, width, height).frame).toContain('Конец');
  expect(readerFrame('Урок', tabs, 1, 0, width, height).frame).toContain('Другой источник');
});

it('выгрузка содержит урок и ссылки, скрывает ключи и исключает исходные результаты инструментов', () => {
  const value = detail();
  value.candidate.lesson += '\nAPI_KEY=fixture-secret\nBearer fixture-auth\nsk-abcdefghijklmnop';
  const markdown = lessonMarkdown(value, true);
  expect(markdown).toContain(value.candidate.sourceRunId);
  expect(markdown).toContain('Сверяйте команды запуска');
  expect(markdown).not.toMatch(
    /fixture-secret|fixture-auth|sk-abcdefghijklmnop|Проверенный исходный результат|fingerprint/,
  );
  expect(markdown).toContain('[ключ скрыт]');
});

it('сохранение не перезаписывает файл и не допускает путь из ID кандидата', async () => {
  const root = await temporary(),
    value = detail();
  const path = await saveLesson(root, value, true);
  expect(await readFile(path, 'utf8')).toContain('## Урок');
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, 'Мои заметки');
  await expect(saveLesson(root, value, true)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path, 'utf8')).toBe('Мои заметки');
  value.candidate.id = '../escape';
  await expect(saveLesson(root, value, true)).rejects.toThrow();
});

it('каталог открывает полный урок без модельных запросов и без изменений опыта', async () => {
  const value = detail(),
    state = {
      ...status(0),
      candidates: [value.candidate],
      activeCandidateIds: [value.candidate.id],
    };
  const request = vi.fn(async (method: string) => (method === 'learning.inspect' ? value : state));
  const context = {
    directory: () => '/unused',
    interactive: () => true,
    json: () => false,
    output: vi.fn(),
    request,
  } as CliContext;
  vi.mocked(prompts.select).mockResolvedValueOnce(value.candidate.id).mockResolvedValueOnce('back');
  vi.mocked(readText).mockResolvedValueOnce('back');
  await browseKnowledge(context);
  expect(readText).toHaveBeenCalledWith(
    expect.stringContaining('Урок'),
    expect.arrayContaining([expect.objectContaining({ id: 'evidence' })]),
    expect.objectContaining({ subtitle: 'Применяется · coordinator' }),
  );
  expect(
    request.mock.calls.every(([method]) =>
      ['learning.status', 'learning.inspect'].includes(method),
    ),
  ).toBe(true);
});

it('локальный статус отдаёт состав активной версии и историю откатов без конфигурации', async () => {
  const value = detail();
  const state: LearningState = {
    schemaVersion: 1,
    activeVersion: 'baseline',
    paused: false,
    candidates: { [value.candidate.id]: value.candidate },
    evidence: {},
    reports: {},
    releases: {
      baseline: { id: 'baseline', createdAt: '', candidateIds: [] },
      revoked: {
        id: 'revoked',
        createdAt: '',
        parentId: 'baseline',
        candidateIds: [value.candidate.id],
        revoked: true,
        reason: 'Регрессия',
      },
    },
    jobs: [],
    daily: { date: '', tokens: 0 },
  };
  const app = {
    learning: { store: { read: () => state } },
    config: {
      value: {
        learning: { enabled: true, dailyTokens: 100000, cases: [] },
        private: 'not-for-export',
      },
    },
  } as unknown as Application;
  const view = (await dispatch(app, 'learning.status', {})) as LearningStatusView;
  expect(view.activeCandidateIds).toEqual([]);
  expect(view.candidates[0]).toMatchObject({ workspace: value.candidate.workspace });
  expect(releaseText(view)).toContain('Регрессия');
  expect(JSON.stringify(view)).not.toContain('not-for-export');
});
