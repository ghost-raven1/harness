import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { syncDirectory } from '../../sessions/files.js';
import type { StatusView } from '../types.js';

function exportError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  const explanation =
    code === 'EEXIST'
      ? 'Файл содержит другой текст. Переименуйте его.'
      : code === 'ENOSPC' || code === 'EDQUOT'
        ? 'На диске недостаточно места. Освободите место и повторите сохранение.'
        : code === 'EFBIG'
          ? 'Ответ слишком большой для выбранного диска.'
          : code === 'EACCES' || code === 'EPERM'
            ? 'Нет доступа для записи в папку задачи. Проверьте права на папку.'
            : code === 'ENOENT' || code === 'ENOTDIR'
              ? 'Папка задачи больше недоступна. Подключите диск и повторите сохранение.'
              : 'Не удалось безопасно записать файл. Проверьте доступность диска и повторите сохранение.';
  return Object.assign(new Error('Ответ не сохранён. ' + explanation, { cause: error }), { code });
}

/** Публикует только целый файл; существующий ответ считается сохранённым лишь при совпадении текста. */
export async function saveAnswer(
  status: Pick<StatusView, 'workspace' | 'runId' | 'result' | 'resultTruncated'>,
): Promise<string> {
  if (status.resultTruncated)
    throw new Error('Ответ ещё не дочитан. Повторите сохранение полного ответа.');
  if (!status.result) throw new Error('У этой задачи пока нет ответа для сохранения.');
  const path = join(status.workspace, 'Ответ Harness ' + status.runId + '.md');
  const temporary = join(status.workspace, '.harness-answer-' + randomUUID() + '.tmp');
  const content = Buffer.from(status.result + '\n', 'utf8');
  let created = false;
  try {
    try {
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        // Жёсткая ссылка публикует целый файл и атомарно отказывает при занятом имени.
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await lstat(path);
        if (
          !existing.isFile() ||
          existing.size !== content.length ||
          !(await readFile(path)).equals(content)
        )
          throw error;
      }
      await syncDirectory(status.workspace);
    } finally {
      if (created) await unlink(temporary);
    }
  } catch (error) {
    throw exportError(error);
  }
  return path;
}
