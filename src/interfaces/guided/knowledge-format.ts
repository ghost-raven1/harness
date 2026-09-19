import { knowledgeText, lessonLabels } from '../../learning/text.js';
import type { LearningInspectView, LearningStatusView } from '../types.js';
import type { TextTab } from './text-reader.js';
import { learningVersionLabel } from './learning-labels.js';

export { knowledgeText, lessonLabels } from '../../learning/text.js';
export { lessonMarkdown, saveLesson } from '../../learning/export.js';

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
