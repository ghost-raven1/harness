import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LearningInspection } from './types.js';
import { knowledgeText, lessonLabels } from './text.js';
import { learningVersionLabel } from './labels.js';

/** Выгрузка урока содержит ссылки на доказательства, без сырых ответов инструментов и конфигов. */
export function lessonMarkdown(detail: LearningInspection, active: boolean): string {
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
  detail: LearningInspection,
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
