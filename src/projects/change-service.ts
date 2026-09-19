import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { ApplicationError } from '../shared/application-error.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';
import {
  projectChangeInputs,
  projectChangeOutputs,
  type ProjectChangeSet,
} from './change-schema.js';
import { ProjectDiffWorker } from './change-worker.js';

interface Entry {
  path: string;
  kind: 'file' | 'symlink';
  digest: string;
  executable: boolean;
  content?: { digest: string; bytes: number };
  unavailableReason?: string;
}
interface Manifest {
  projectId: string;
  snapshotDigest: string;
  snapshotRef: string;
  entries: Entry[];
}
interface ChangeProject {
  id: string;
  revision: number;
  deletedAt?: string;
  changeSets?: ProjectChangeSet[];
}
interface ChangeOptions {
  readProject: (projectId: string) => Promise<ChangeProject>;
  content: {
    readContentManifest: (projectId: string, ref: string) => Promise<Manifest>;
    readContent: (projectId: string, ref: string, path: string) => Promise<string>;
  };
  workspace: { readEntries: (projectId: string, ref: string) => Promise<Entry[]> };
  worker?: ProjectDiffWorker;
}
type Input<K extends keyof typeof projectChangeInputs> = z.input<(typeof projectChangeInputs)[K]>;
type Output<K extends keyof typeof projectChangeOutputs> = z.output<
  (typeof projectChangeOutputs)[K]
>;
type FileChange = Output<'changes'>['items'][number];
const reasons: Record<string, string> = {
  disabled: 'Сохранение текста было выключено.',
  policy: 'Правила проекта не разрешают автоматическое чтение файла.',
  symlink: 'Символическая ссылка: содержимое цели не сохраняется.',
  'too-large': 'Файл превышает предел сохранения текста.',
  binary: 'Двоичный файл: доступны только метаданные.',
  encoding: 'Файл не является корректным текстом UTF-8.',
  'project-limit': 'Достигнут предел сохранённых исходников проекта.',
  'total-limit': 'Достигнут общий предел сохранённых исходников Harness.',
  historical: 'В этой контрольной точке текст не сохранялся.',
};
const unavailable = (reason: string) => ({ state: 'unavailable' as const, text: '', reason });

/** Показывает только сохранённые точки; просмотр не обращается к рабочей папке и ничего не пишет. */
export class ProjectChangeService {
  readonly worker: ProjectDiffWorker;
  constructor(private readonly options: ChangeOptions) {
    this.worker = options.worker ?? new ProjectDiffWorker();
  }

  /** Каталог интервалов не загружает содержимое файлов. */
  async changeSets(input: Input<'changeSets'>): Promise<Output<'changeSets'>> {
    const request = projectChangeInputs.changeSets.parse(input);
    const project = await this.project(request.projectId);
    const all = [...(project.changeSets ?? [])].reverse();
    const items = all.slice(request.offset, request.offset + request.limit).map((item) => {
      return this.summary(item);
    });
    return projectChangeOutputs.changeSets.parse({
      projectId: project.id,
      revision: project.revision,
      items,
      total: all.length,
      nextOffset:
        request.offset + items.length < all.length ? request.offset + items.length : undefined,
    });
  }

  /** Сравнивает метаданные по пути, сохраняя непрозрачный идентификатор выбранного файла. */
  async changes(input: Input<'changes'>): Promise<Output<'changes'>> {
    const request = projectChangeInputs.changes.parse(input);
    const interval = await this.interval(request.projectId, request.changeSetId);
    if (interval.outcome !== 'complete' || !interval.after)
      return {
        projectId: request.projectId,
        changeSetId: interval.id,
        interval: this.summary(interval),
        items: [],
        total: 0,
        complete: false,
        reason:
          interval.reason ??
          (interval.outcome === 'pending'
            ? 'Интервал ещё выполняется.'
            : 'После аварии точное состояние файлов не сохранилось.'),
      };
    try {
      const { files } = await this.files(request.projectId, interval);
      const items = files.slice(request.offset, request.offset + request.limit);
      return {
        projectId: request.projectId,
        changeSetId: interval.id,
        interval: this.summary(interval),
        items,
        total: files.length,
        nextOffset:
          request.offset + items.length < files.length ? request.offset + items.length : undefined,
        complete: files.every(
          (file) =>
            (!file.before || file.before.available) && (!file.after || file.after.available),
        ),
      };
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        (error instanceof ApplicationError && error.code === 'INVALID_REQUEST')
      )
        throw error;
      return {
        projectId: request.projectId,
        changeSetId: interval.id,
        interval: this.summary(interval),
        items: [],
        total: 0,
        complete: false,
        reason: 'Сохранённая контрольная точка недоступна или повреждена.',
      };
    }
  }

  /** Страницы содержат не больше 16 384 символов и не разрывают суррогатные пары Unicode. */
  async fileChange(input: Input<'fileChange'>): Promise<Output<'fileChange'>> {
    const request = projectChangeInputs.fileChange.parse(input);
    const interval = await this.interval(request.projectId, request.changeSetId);
    const base = {
      ...request,
      path: '',
      text: '',
      offset: request.offset,
      totalCharacters: 0,
      complete: false,
    };
    if (interval.outcome !== 'complete' || !interval.after)
      return { ...base, ...unavailable('Интервал не содержит завершённого сравнения.') };
    let files: Awaited<ReturnType<ProjectChangeService['files']>>;
    try {
      files = await this.files(request.projectId, interval);
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        (error instanceof ApplicationError && error.code === 'INVALID_REQUEST')
      )
        throw error;
      return {
        ...base,
        ...unavailable('Сохранённая контрольная точка недоступна или повреждена.'),
      };
    }
    const file = files.files.find((item) => item.fileId === request.fileId);
    if (!file)
      throw new ApplicationError('INVALID_REQUEST', 'Файл не принадлежит выбранному сравнению.');
    base.path = file.path;
    const before = files.before.get(file.path);
    const after = files.after.get(file.path);
    const sides = request.view === 'diff' ? [file.before, file.after] : [file[request.view]];
    const missing = sides.find((side) => side && !side.available);
    if (missing)
      return { ...base, ...unavailable(missing.reason ?? 'Сохранённый текст недоступен.') };
    try {
      const read = async (side: 'before' | 'after'): Promise<string> => {
        const entry = side === 'before' ? before : after;
        if (!entry) return '';
        const ref = interval[side]?.contentRef;
        if (!ref) throw new Error('Нет сохранённого содержимого.');
        return this.options.content.readContent(request.projectId, ref, file.path);
      };
      // Проверка копии выполняется и при попадании в LRU; очередь загружает одну пару за раз.
      const result =
        request.view === 'diff'
          ? await this.worker.compute(
              request.projectId,
              this.cacheKey(interval, file),
              file.path,
              async () => ({ before: await read('before'), after: await read('after') }),
            )
          : { state: 'available' as const, text: await read(request.view) };
      // Удаление между чтением и ответом не возвращает исходники уже удалённого проекта.
      await this.interval(request.projectId, request.changeSetId);
      let start = Math.min(request.offset, result.text.length);
      if (
        start > 0 &&
        /[\uDC00-\uDFFF]/u.test(result.text[start] ?? '') &&
        /[\uD800-\uDBFF]/u.test(result.text[start - 1] ?? '')
      )
        start--;
      let end = Math.min(start + 16_384, result.text.length);
      if (
        end < result.text.length &&
        /[\uD800-\uDBFF]/u.test(result.text[end - 1] ?? '') &&
        /[\uDC00-\uDFFF]/u.test(result.text[end] ?? '')
      )
        end--;
      return {
        ...base,
        ...result,
        text: result.text.slice(start, end),
        offset: start,
        nextOffset: end < result.text.length ? end : undefined,
        totalCharacters: result.text.length,
        complete: result.state === 'available',
      };
    } catch (error) {
      if (
        error instanceof ResourceNotFoundError ||
        (error instanceof ApplicationError && error.code === 'INVALID_REQUEST')
      )
        throw error;
      return {
        ...base,
        ...unavailable(
          'Сохранённый текст недоступен или повреждён. Рабочая папка не используется вместо копии.',
        ),
      };
    }
  }

  /** Потоковый экспорт читает общий итог по одному файлу, не удерживая все diff в памяти. */
  async *exportChanges(
    projectId: string,
    changeSetId?: string,
  ): AsyncGenerator<{
    change: FileChange;
    pages: AsyncGenerator<Output<'fileChange'>>;
  }> {
    const project = await this.project(projectId);
    const interval = changeSetId
      ? await this.interval(projectId, changeSetId)
      : [...(project.changeSets ?? [])]
          .reverse()
          .find((item) => item.kind === 'project' && item.outcome === 'complete');
    if (!interval) return;
    let offset = 0;
    do {
      const list = await this.changes({ projectId, changeSetId: interval.id, offset, limit: 100 });
      if (list.reason) throw new ApplicationError('STORAGE_UNAVAILABLE', list.reason);
      for (const change of list.items) {
        const service = this;
        yield {
          change,
          pages: (async function* () {
            let pageOffset = 0;
            do {
              const page = await service.fileChange({
                projectId,
                changeSetId: interval.id,
                fileId: change.fileId,
                view: 'diff',
                offset: pageOffset,
              });
              yield page;
              if (page.nextOffset === undefined) break;
              pageOffset = page.nextOffset;
            } while (true);
          })(),
        };
      }
      if (list.nextOffset === undefined) break;
      offset = list.nextOffset;
    } while (true);
  }

  /** Координатор удаления и сброса очищает кэш до освобождения служебных файлов. */
  forget(projectId?: string): void {
    this.worker.forget(projectId);
  }
  /** Останавливает выделенный поток при завершении локального сервиса. */
  async close(): Promise<void> {
    await this.worker.close();
  }

  /** Публичный обзор не раскрывает внутренние пути хранилища. */
  private summary(item: ProjectChangeSet) {
    const point = (value: ProjectChangeSet['before']) => ({
      createdAt: value.createdAt,
      digest: value.digest,
      files: value.files,
    });
    return { ...item, before: point(item.before), after: item.after && point(item.after) };
  }
  /** Отсутствующая запись сохраняет отдельный код для возврата интерфейса к списку. */
  private async project(projectId: string): Promise<ChangeProject> {
    const project = await this.options.readProject(projectId);
    if (project.id !== projectId || project.deletedAt)
      throw new ApplicationError('INVALID_REQUEST', 'Проект удалён или недоступен.');
    return project;
  }
  /** Сравнение выбирается по журналу проекта, а не по переданным клиентом ссылкам. */
  private async interval(projectId: string, changeSetId: string): Promise<ProjectChangeSet> {
    const project = await this.project(projectId);
    const interval = project.changeSets?.find((item) => item.id === changeSetId);
    if (!interval)
      throw new ApplicationError('INVALID_REQUEST', 'Сравнение не принадлежит проекту.');
    return interval;
  }
  /** Проверяет связь копии с точным манифестом хешей; старые записи читаются без миграции. */
  private async entries(projectId: string, point: ProjectChangeSet['before']): Promise<Entry[]> {
    if (!point.contentRef)
      return (await this.options.workspace.readEntries(projectId, point.ref)).map((entry) => ({
        ...entry,
        unavailableReason: entry.kind === 'symlink' ? 'symlink' : 'historical',
      }));
    const manifest = await this.options.content.readContentManifest(projectId, point.contentRef);
    if (
      manifest.projectId !== projectId ||
      manifest.snapshotDigest !== point.digest ||
      manifest.snapshotRef !== point.ref
    )
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Содержимое не принадлежит выбранной контрольной точке.',
      );
    return manifest.entries;
  }
  /** Метаданные различают исчезновение, новый тип и смену прав независимо от доступности текста. */
  private async files(projectId: string, interval: ProjectChangeSet) {
    const before = new Map(
      (await this.entries(projectId, interval.before)).map((entry) => [entry.path, entry]),
    );
    const after = new Map(
      (await this.entries(projectId, interval.after!)).map((entry) => [entry.path, entry]),
    );
    const side = (entry: Entry | undefined) =>
      entry && {
        kind: entry.kind,
        digest: entry.digest,
        executable: entry.executable,
        available: Boolean(entry.content),
        reason: entry.content
          ? undefined
          : (reasons[entry.unavailableReason ?? 'historical'] ?? 'Текст не сохранён.'),
      };
    const files: FileChange[] = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(path);
      const next = after.get(path);
      if (
        previous &&
        next &&
        previous.digest === next.digest &&
        previous.kind === next.kind &&
        previous.executable === next.executable
      )
        continue;
      files.push({
        fileId: createHash('sha256')
          .update(interval.id + '\0' + path)
          .digest('hex'),
        path,
        kind: !previous ? 'added' : !next ? 'deleted' : 'modified',
        typeChanged: Boolean(previous && next && previous.kind !== next.kind),
        executableChanged: Boolean(previous && next && previous.executable !== next.executable),
        before: side(previous),
        after: side(next),
      });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { files, before, after };
  }
  /** Ключ закрепляет обе неизменные точки и параметры выбранного файла. */
  private cacheKey(interval: ProjectChangeSet, file: FileChange): string {
    return createHash('sha256')
      .update(
        JSON.stringify([interval.id, interval.before.contentRef, interval.after?.contentRef, file]),
      )
      .digest('hex');
  }
}
