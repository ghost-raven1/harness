import type { ProjectReview, EvidenceCheck } from '../projects/read-schema.js';
import type { ProjectRecord, VersionedPlan } from '../projects/types.js';
import type { CheckResult } from '../projects/evidence-cache.js';

/** Белый список исключает конфигурацию и сохраняет только метаданные, без накопления журналов. */
export function exportDocument(
  project: ProjectRecord,
  review: ProjectReview,
  acceptedPlan?: VersionedPlan,
) {
  return {
    schemaVersion: 1,
    projectId: project.id,
    revision: project.revision,
    title: review.title,
    goal: review.goal,
    acceptedVersion: project.acceptedVersion,
    plan: acceptedPlan,
    stages: review.stages,
    changes: review.changes,
    changesTruncated: review.changesTruncated,
    reports: review.reports,
    freshness: review.freshness,
    checkedAt: review.checkedAt,
    remaining: review.blockers,
  };
}
type Document = ReturnType<typeof exportDocument>;
type ReadLog = (reportId: string, checkId: string) => Promise<CheckResult | undefined>;

/** Сериализует по одной команде: размер всего экспорта не увеличивает объём удерживаемых журналов. */
export async function* exportChunks(
  document: Document,
  format: 'markdown' | 'json',
  readLog?: ReadLog,
  readDiffs?: () => AsyncGenerator<string>,
): AsyncGenerator<string> {
  if (format === 'json') {
    const { reports, ...header } = document;
    yield JSON.stringify(header, null, 2).slice(0, -1) + ',"reports":[\n';
    let reportSeparator = '';
    for (const report of reports) {
      const { checks, ...metadata } = report;
      yield reportSeparator + JSON.stringify(metadata).slice(0, -1) + ',"checks":[\n';
      reportSeparator = ',\n';
      let checkSeparator = '';
      for (const check of checks) {
        const log = await readLog?.(report.id, check.id);
        yield checkSeparator + JSON.stringify({ ...check, ...(log ? { log } : {}) });
        checkSeparator = ',\n';
      }
      yield ']}';
    }
    yield ']';
    if (readDiffs) yield* readDiffs();
    yield '}\n';
    return;
  }
  yield markdownIntroduction(document);
  for (const report of document.reports) {
    yield '\n### ' +
      report.phase +
      ' · попытка ' +
      report.attempt +
      (report.current ? '' : ' · прежняя версия') +
      '\n\nСостояние: ' +
      report.status +
      '\n';
    for (const check of report.checks) {
      yield markdownCheck(check);
      const log = await readLog?.(report.id, check.id);
      if (log)
        for (const stream of ['stdout', 'stderr'] as const) {
          yield '\n' +
            stream +
            (log[stream === 'stdout' ? 'stdoutTruncated' : 'stderrTruncated']
              ? ' · ОБРЕЗАНО ИСПОЛНИТЕЛЕМ'
              : '') +
            '\n\n';
          yield code(log[stream]) + '\n';
        }
    }
  }
  if (readDiffs) yield* readDiffs();
  yield '\n## Актуальность и замечания\n\nФайлы: ' +
    document.freshness +
    '\nПроверено: ' +
    document.checkedAt +
    '\n' +
    document.remaining.map((message) => '- ' + message).join('\n') +
    '\n';
}

/** Короткие секции не удерживают результаты команд. */
function markdownIntroduction(document: Document): string {
  const result = [
    '# ' + document.title.replace(/[\r\n]/g, ' '),
    '',
    '## Цель',
    '',
    document.goal,
    '',
    '## Принятый план',
    '',
    document.plan ? code(JSON.stringify(document.plan, null, 2)) : 'План ещё не принят.',
    '',
    '## Результаты этапов',
  ];
  for (const stage of document.stages)
    result.push(
      '',
      '### ' + stage.title,
      '',
      'Ожидалось: ' + stage.expected,
      '',
      'Получено: ' + stage.received,
      '',
      'Подтверждено: ' + (stage.confirmed ? 'да' : 'нет'),
    );
  result.push(
    '',
    '## Изменённые файлы',
    '',
    ...document.changes.map((change) => '- ' + change.kind + ': ' + change.path),
  );
  if (document.changesTruncated) result.push('Список изменений сокращён до первых 1 000 файлов.');
  return result.join('\n') + '\n\n## Проверки\n';
}

/** Буквальный argv выводится отдельно от результата команды. */
function markdownCheck(check: EvidenceCheck): string {
  return (
    '\n#### ' +
    check.title +
    '\n\n' +
    code(JSON.stringify({ command: check.command, args: check.args }, null, 2)) +
    '\nСостояние: ' +
    check.state +
    ' · код: ' +
    String(check.exitCode ?? 'не получен') +
    '\nДоказательство: ' +
    check.evidence +
    '\n'
  );
}

/** Ограждение длиннее последовательностей пользователя не позволяет закрыть блок раньше времени. */
function code(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return fence + '\n' + text + '\n' + fence;
}
