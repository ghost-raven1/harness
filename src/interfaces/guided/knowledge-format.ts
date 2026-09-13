import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LearningCandidate } from '../../learning/types.js';
import type { LearningInspectView, LearningStatusView } from '../types.js';
import { terminalText } from './screen.js';
import type { TextTab } from './text-reader.js';
import { learningVersionLabel } from './learning-labels.js';

export const lessonLabels: Record<LearningCandidate['status'], string> = {
  candidate: 'Кандидат',
  evaluating: 'Проверяется',
  published: 'Опубликован',
  rejected: 'Отклонён',
  revoked: 'Отозван',
};

/** Скрывает распространённые форматы ключей даже у отклонённых кандидатов. */
export function knowledgeText(value: string): string {
  return terminalText(value)
    .replace(/\bsk-[a-z0-9_-]{12,}/gi, '[ключ скрыт]')
    .replace(/\bBearer\s+[a-z0-9._~+\/-]+/gi, 'Bearer [ключ скрыт]')
    .replace(
      /((?:api[_ -]?key|password|secret|access[_ -]?token|token)["']?\s*[:=]\s*["']?)[^\s"',;\}\]]+/gi,
      '$1[ключ скрыт]',
    );
}

/** Отдельные вкладки сохраняют полный текст урока и проверяемых источников. */
export function knowledgeTabs(detail: LearningInspectView, active: boolean): TextTab[] {
  const { candidate, evidence, report } = detail;
  const lesson = [
    candidate.title,
    active
      ? 'Применяется к новым задачам в указанной области.'
      : 'Сейчас не применяется. ' + lessonLabels[candidate.status] + '.',
    candidate.reason ? 'Причина: ' + candidate.reason : '',
    '\nУрок\n' + candidate.lesson,
    '\nКогда применять\n' + candidate.appliesWhen,
    '\nОбласть применения',
    'Папка: ' + candidate.workspace,
    'Роль: ' + candidate.role,
    'Профиль модели: ' + candidate.profile,
    '\nИсходная задача: ' + candidate.sourceRunId,
    'ID урока: ' + candidate.id,
  ]
    .filter(Boolean)
    .join('\n');
  const proof = evidence.length
    ? evidence
        .map((item, index) => {
          if (!item) return 'Источник ' + (index + 1) + ': запись недоступна.';
          let content = item.content;
          try {
            content = JSON.stringify(JSON.parse(content), null, 2);
          } catch {
            /* Источником может быть обычный текст отзыва. */
          }
          return [
            'Источник ' +
              (index + 1) +
              ' · ' +
              (item.kind === 'tool' ? 'Инструмент' : 'Отзыв человека'),
            item.verified ? 'Проверяемый источник подтверждён.' : 'Источник не подтверждён.',
            'Задача: ' + item.runId,
            'Роль: ' + item.role,
            'ID: ' + item.id,
            content,
          ].join('\n');
        })
        .join('\n\n')
    : 'Доказательства не найдены. Урок не может применяться без проверки.';
  const evaluation = report
    ? [
        report.passed === true
          ? 'Оценка пройдена.'
          : report.passed === false
            ? 'Оценка не пройдена.'
            : 'Оценка не завершена.',
        report.reason ?? '',
        'Опыт до проверки: ' + learningVersionLabel(report.baselineVersion),
        'Контрольный набор: ' + report.suiteHash,
        ...report.results.map(
          (result) =>
            '\n' +
            result.caseId +
            ' · ' +
            (result.variant === 'baseline' ? 'Текущая версия' : 'С уроком') +
            ' · повтор ' +
            result.repetition +
            '\n' +
            (result.passed ? 'Пройдено' : 'Не пройдено') +
            '\n' +
            result.detail,
        ),
      ]
        .filter(Boolean)
        .join('\n')
    : 'Оценка ещё не проводилась. Без успешной оценки урок не применяется автоматически.';
  return [
    { id: 'lesson', label: 'Урок', text: knowledgeText(lesson) },
    { id: 'evidence', label: 'Доказательства', text: knowledgeText(proof) },
    { id: 'evaluation', label: 'Оценка', text: knowledgeText(evaluation) },
  ];
}

/** Выгрузка урока содержит ссылки на доказательства, без сырых ответов инструментов и конфигов. */
export function lessonMarkdown(detail: LearningInspectView, active: boolean): string {
  const { candidate, report } = detail;
  return knowledgeText(
    [
      '# ' + candidate.title,
      '',
      active
        ? 'Применяется к новым задачам в своей области.'
        : 'Не применяется. Статус: ' + lessonLabels[candidate.status] + '.',
      candidate.reason ? '\nПричина: ' + candidate.reason : '',
      '\n## Урок\n\n' + candidate.lesson,
      '\n## Когда применять\n\n' + candidate.appliesWhen,
      '\n## Область применения\n',
      '- Папка: ' + candidate.workspace,
      '- Роль: ' + candidate.role,
      '- Профиль модели: ' + candidate.profile,
      '- ID урока: ' + candidate.id,
      '- Исходная задача: ' + candidate.sourceRunId,
      '\n## Доказательства\n',
      ...detail.evidence.map((item, index) =>
        item
          ? '- ' +
            item.id +
            ' · задача ' +
            item.runId +
            ' · ' +
            (item.kind === 'tool' ? 'инструмент' : 'отзыв') +
            ' · ' +
            (item.verified ? 'подтверждено' : 'не подтверждено')
          : '- Источник ' + (index + 1) + ' недоступен',
      ),
      '\nСодержимое исходных результатов доступно в Harness на вкладке «Доказательства».',
      '\n## Оценка\n',
      report
        ? (report.passed === true ? 'Пройдена.' : 'Не пройдена или не завершена.') +
          '\nОпыт до проверки: ' +
          learningVersionLabel(report.baselineVersion) +
          '\nПроверок пройдено: ' +
          report.results.filter((item) => item.passed).length +
          ' / ' +
          report.results.length
        : 'Ещё не проводилась.',
      '',
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  );
}

/** Новый файл создаётся с запретом перезаписи; имя не зависит от текста модели. */
export async function saveLesson(
  directory: string,
  detail: LearningInspectView,
  active: boolean,
): Promise<string> {
  const candidateId = z.string().uuid().parse(detail.candidate.id);
  const destination = join(directory, 'exports');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if ((await lstat(destination)).isSymbolicLink())
    throw new Error('Папка exports не должна быть символической ссылкой.');
  const path = join(destination, 'Урок Harness ' + candidateId + '.md');
  await writeFile(path, lessonMarkdown(detail, active), { flag: 'wx', mode: 0o600 });
  return path;
}

/** Начальное состояние не является выпуском; в истории показываются только реальные публикации. */
export function releaseText(state: LearningStatusView): string {
  const releases = (state.releases ?? []).filter((release) => release.id !== 'baseline');
  const current =
    state.activeVersion === 'baseline'
      ? 'Новые задачи используют основные инструкции, без накопленного опыта.'
      : 'Для новых задач: ' + learningVersionLabel(state.activeVersion);
  if (!releases.length) {
    const next = !state.enabled
      ? 'Обучение выключено в настройках.'
      : state.paused
        ? 'Обучение приостановлено. Возобновить его можно в настройках самообучения.'
        : state.evaluationReady
          ? 'Первый выпуск появится, когда полезный урок пройдёт проверку.'
          : 'Для выпуска нужно настроить контрольные задачи обучения — проверки полезности уроков.';
    return knowledgeText(
      [
        'Выпусков знаний пока нет.',
        current,
        next,
        'Уроки и их проверки доступны в базе знаний.',
      ].join('\n\n'),
    );
  }
  const titles = new Map(state.candidates.map((candidate) => [candidate.id, candidate.title]));
  const history = releases.reverse().map((release) => {
    const date = new Date(release.createdAt);
    return [
      learningVersionLabel(release.id),
      release.revoked
        ? 'Отозван · не применяется'
        : release.id === state.activeVersion
          ? 'Применяется к новым задачам'
          : 'Сохранён в истории · не применяется',
      Number.isNaN(date.getTime())
        ? 'Дата создания не сохранена.'
        : 'Создан: ' +
          date.toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
      release.parentId && release.parentId !== 'baseline'
        ? 'На основе: ' + learningVersionLabel(release.parentId)
        : '',
      release.reason ? 'Причина: ' + release.reason : '',
      'Уроков в выпуске: ' + release.candidateIds.length,
      ...release.candidateIds.map((id) => '  • ' + (titles.get(id) ?? 'Урок ' + id)),
    ]
      .filter(Boolean)
      .join('\n');
  });
  return knowledgeText([current, ...history].join('\n\n'));
}
