import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { ProjectChangeService } from '../projects/change-service.js';
import type { projectReadOutputs } from '../projects/read-schema.js';
import { ApplicationError } from '../shared/application-error.js';

type DiffSummary = NonNullable<z.output<typeof projectReadOutputs.exportPreview>['diffs']>;
interface PreparedDiffs {
  summary: DiffSummary;
  digest: string;
}
/** Предпросмотр удерживает только ограниченный список файлов и checksum полного текста. */
export async function prepareExportDiffs(
  service: ProjectChangeService,
  projectId: string,
): Promise<PreparedDiffs> {
  const summary: DiffSummary = {
    files: 0,
    unavailable: 0,
    characters: 0,
    items: [],
    truncated: false,
  };
  const digest = createHash('sha256');
  for await (const file of service.exportChanges(projectId)) {
    summary.files++;
    digest.update(JSON.stringify(file.change) + '\n');
    let first = true;
    for await (const page of file.pages) {
      digest.update(JSON.stringify(page) + '\n');
      if (first) {
        summary.characters += page.totalCharacters;
        if (page.state !== 'available') summary.unavailable++;
        if (summary.items.length < 40)
          summary.items.push({ path: file.change.path, state: page.state, reason: page.reason });
        first = false;
      }
    }
  }
  summary.truncated = summary.files > summary.items.length;
  return { summary, digest: digest.digest('hex') };
}

/** Публикация проверяет checksum предпросмотра после чтения всех страниц и до фиксации файла. */
export async function* exportDiffChunks(
  service: ProjectChangeService,
  projectId: string,
  expectedDigest: string,
  format: 'markdown' | 'json',
): AsyncGenerator<string> {
  const digest = createHash('sha256');
  yield format === 'json' ? ',"diffs":[\n' : '\n## Сравнение исходников\n\n';
  let separator = '';
  let files = 0;
  for await (const file of service.exportChanges(projectId)) {
    files++;
    digest.update(JSON.stringify(file.change) + '\n');
    let first = true;
    let lineStart = true;
    for await (const page of file.pages) {
      digest.update(JSON.stringify(page) + '\n');
      if (first) {
        const metadata = { ...file.change, state: page.state, reason: page.reason };
        yield format === 'json'
          ? separator + JSON.stringify(metadata).slice(0, -1) + ',"text":"'
          : '### ' +
            JSON.stringify(file.change.path) +
            '\n\n' +
            (page.reason ? page.reason + '\n\n' : '');
        first = false;
      }
      if (format === 'json') yield JSON.stringify(page.text).slice(1, -1);
      else {
        // Отступы сохраняют буквальные обратные кавычки без накопления текста ради выбора ограждения.
        let chunk = '';
        for (const part of page.text.split(/(?<=\n)/u)) {
          if (!part) continue;
          chunk += (lineStart ? '    ' : '') + part;
          lineStart = part.endsWith('\n');
        }
        yield chunk;
      }
    }
    yield format === 'json' ? '"}' : '\n\n';
    separator = ',\n';
  }
  if (format === 'json') yield ']';
  else if (!files) yield 'Сохранённого общего сравнения пока нет.\n';
  if (digest.digest('hex') !== expectedDigest)
    throw new ApplicationError(
      'STALE_PREVIEW',
      'Сохранённые исходники изменились. Повторите предпросмотр экспорта.',
    );
}
