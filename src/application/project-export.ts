import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '../projects/store.js';
import type { ProjectRecord, VersionedPlan } from '../projects/types.js';
import type { ProjectEvidenceService } from '../projects/evidence.js';
import { projectReadInputs, projectReadOutputs } from '../projects/read-schema.js';
import { atomicJson, assertRealDirectory, syncDirectory } from '../sessions/files.js';
import { hash } from '../shared/primitives.js';
import { ApplicationError } from '../shared/application-error.js';
import { exportDocument, exportChunks } from './project-export-format.js';

interface Dependencies {
  directory: string;
  projects: ProjectStore;
  evidence: ProjectEvidenceService;
  serialize<T>(work: () => Promise<T>): Promise<T>;
  assertWritable(): void;
  acceptedPlan?(project: ProjectRecord): Promise<VersionedPlan | undefined>;
}
const receiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestHash: z.string(),
    previewToken: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    temporary: z.string().uuid(),
    result: projectReadOutputs.exportReport,
  })
  .strict();

/** Экспорт сериализуется с удалением проекта и публикует только управляемые файлы состояния. */
export class ProjectExportService {
  constructor(private readonly dependencies: Dependencies) {}

  /** Предпросмотр показывает состав, пользовательские команды и объём необязательных журналов. */
  preview(raw: z.input<typeof projectReadInputs.exportPreview>) {
    const input = projectReadInputs.exportPreview.parse(raw);
    return this.dependencies.serialize(async () => {
      const prepared = await this.prepare(input);
      return prepared.preview;
    });
  }

  /** Устойчивое намерение позволяет вернуть тот же файл после потери ответа или перезапуска. */
  export(raw: z.input<typeof projectReadInputs.exportReport>) {
    const input = projectReadInputs.exportReport.parse(raw);
    return this.dependencies.serialize(async () => {
      this.dependencies.assertWritable();
      // Проверка проекта прежде квитанции не позволяет воскресить экспорт удалённого проекта.
      await this.dependencies.projects.get(input.projectId);
      const directory = await this.exportDirectory(input.projectId, true);
      const requestHash = hash(input);
      const receiptPath = join(directory, hash(input.requestKey) + '.json');
      const previous = await this.receipt(receiptPath);
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new ApplicationError(
            'INVALID_REQUEST',
            'Ключ экспорта уже использован с другими параметрами.',
          );
        const previousPath = join(
          directory,
          hash(input.requestKey) + (input.format === 'json' ? '.report.json' : '.md'),
        );
        if (
          previous.result.projectId !== input.projectId ||
          previous.result.revision !== input.expectedRevision ||
          previous.result.format !== input.format ||
          previous.result.includeLogs !== input.includeLogs ||
          previous.result.path !== previousPath
        )
          throw new ApplicationError(
            'STORAGE_UNAVAILABLE',
            'Квитанция не соответствует запросу экспорта.',
          );
        try {
          await this.finish(directory, previous);
        } catch (cause) {
          if (cause instanceof ApplicationError) throw cause;
          throw new ApplicationError(
            'STORAGE_UNAVAILABLE',
            'Подтверждённый экспорт недоступен. Повторите запрос после восстановления хранения.',
            { cause },
          );
        }
        return previous.result;
      }
      const prepared = await this.prepare(input);
      if (prepared.preview.previewToken !== input.previewToken)
        throw new ApplicationError(
          'STALE_PREVIEW',
          'Проект или доказательства изменились. Повторите предпросмотр экспорта.',
        );
      const basename = hash(input.requestKey) + (input.format === 'json' ? '.report.json' : '.md');
      const result = {
        projectId: input.projectId,
        revision: input.expectedRevision,
        path: join(directory, basename),
        format: input.format,
        includeLogs: input.includeLogs,
        bytes: 0,
      };
      const temporary = randomUUID();
      const path = join(directory, temporary + '.tmp');
      let publicationAttempted = false;
      const digest = createHash('sha256');
      try {
        const file = await open(path, 'wx', 0o600);
        try {
          const readLog = input.includeLogs
            ? async (reportId: string, checkId: string) => {
                const source = prepared.project.reports.find((report) => report.id === reportId);
                const log = source
                  ? (await this.dependencies.evidence.readCheck(prepared.project, source, checkId))
                      .result
                  : undefined;
                if (hash(log ?? null) !== prepared.logDigests.get(reportId + ':' + checkId))
                  throw new ApplicationError(
                    'STALE_PREVIEW',
                    'Журнал изменился после предпросмотра. Повторите подтверждение.',
                  );
                return log;
              }
            : undefined;
          for await (const chunk of exportChunks(prepared.document, input.format, readLog)) {
            digest.update(chunk);
            result.bytes += Buffer.byteLength(chunk);
            await file.writeFile(chunk);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        const receipt = {
          schemaVersion: 1 as const,
          requestHash,
          previewToken: input.previewToken,
          digest: digest.digest('hex'),
          temporary,
          result,
        };
        publicationAttempted = true;
        await atomicJson(receiptPath, receipt);
        await this.finish(directory, receipt);
        return result;
      } catch (cause) {
        let keepTemporary = publicationAttempted;
        if (publicationAttempted) {
          try {
            keepTemporary = (await this.receipt(receiptPath))?.temporary === temporary;
          } catch {
            /* Неопределённый fsync намерения не уничтожает единственную подготовленную копию. */
          }
        }
        if (!keepTemporary) await unlink(path).catch(() => undefined);
        if (cause instanceof ApplicationError) throw cause;
        throw new ApplicationError(
          'STORAGE_UNAVAILABLE',
          'Не удалось сохранить экспорт. Освободите место и повторите тот же запрос.',
          { cause },
        );
      }
    });
  }

  /** Формирует одинаковый токен по содержимому, исключая изменчивое время просмотра. */
  private async prepare(input: z.output<typeof projectReadInputs.exportPreview>) {
    const project = await this.dependencies.projects.get(input.projectId);
    if (project.revision !== input.expectedRevision)
      throw new ApplicationError(
        'STALE_PREVIEW',
        'Проект изменился. Обновите экран перед экспортом.',
      );
    const review = await this.dependencies.evidence.review({ projectId: input.projectId });
    const acceptedPlan =
      project.acceptedVersion === project.plan?.version
        ? project.plan
        : await this.dependencies.acceptedPlan?.(project);
    const document = exportDocument(project, review, acceptedPlan);
    const commands: Array<{ command: string; args: string[] }> = [];
    const commandDigests = new Set<string>();
    const logs: z.infer<typeof projectReadOutputs.exportPreview>['logs'] = [];
    const logDigests = new Map<string, string>();
    const contentDigest = createHash('sha256');
    for (const report of review.reports) {
      const source = project.reports.find((item) => item.id === report.id);
      for (const check of report.checks) {
        const command = { command: check.command, args: check.args };
        const commandDigest = hash(command);
        if (!commandDigests.has(commandDigest)) {
          commands.push(command);
          commandDigests.add(commandDigest);
        }
        const log =
          input.includeLogs && source
            ? (await this.dependencies.evidence.readCheck(project, source, check.id)).result
            : undefined;
        const digest = hash(log ?? null);
        logDigests.set(report.id + ':' + check.id, digest);
        contentDigest.update(JSON.stringify([report.id, check.id, digest]) + '\n');
        logs.push({
          reportId: report.id,
          checkId: check.id,
          stdoutCharacters: log?.stdout.length ?? 0,
          stderrCharacters: log?.stderr.length ?? 0,
          stdoutTruncated: check.stdoutTruncated ?? false,
          stderrTruncated: check.stderrTruncated ?? false,
          available: check.evidence === 'available',
          ...(log && logs.length < 40
            ? { stdoutPreview: log.stdout.slice(0, 1000), stderrPreview: log.stderr.slice(0, 1000) }
            : {}),
        });
      }
    }
    const { checkedAt: _checkedAt, ...stableReview } = review;
    const previewToken = hash({
      projectId: project.id,
      revision: project.revision,
      format: input.format,
      includeLogs: input.includeLogs,
      review: stableReview,
      logDigest: input.includeLogs ? contentDigest.digest('hex') : undefined,
    });
    return {
      document,
      project,
      logDigests,
      preview: {
        projectId: project.id,
        revision: project.revision,
        previewToken,
        format: input.format,
        includeLogs: input.includeLogs,
        sections: [
          'Цель',
          'Принятый план',
          'Результаты этапов',
          'Изменённые файлы',
          'Автоматические и ручные проверки',
          ...(input.includeLogs ? ['Сохранённые stdout и stderr'] : []),
        ],
        commands,
        logs,
        destination: await this.exportDirectory(project.id, false),
        warnings: [
          'Отчёт содержит цель проекта, пользовательские команды и их аргументы.',
          ...(input.includeLogs && logs.length > 40
            ? [
                'Фрагменты показаны для первых 40 команд; остальные журналы доступны в карточках проверок.',
              ]
            : []),
          ...(input.includeLogs
            ? ['Журналы могут содержать данные, напечатанные вашими программами.']
            : []),
          ...(project.acceptedVersion !== project.plan?.version
            ? ['Текущая редакция плана ещё не принята.']
            : []),
        ],
      },
    };
  }

  /** Непринятый проект не экспортирует конфигурацию или параметры подключения. */
  private async exportDirectory(projectId: string, create: boolean): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(projectId))
      throw new ApplicationError('INVALID_REQUEST', 'Некорректный идентификатор проекта.');
    const folders = [
      this.dependencies.directory,
      join(this.dependencies.directory, 'exports'),
      join(this.dependencies.directory, 'exports', 'projects'),
      join(this.dependencies.directory, 'exports', 'projects', projectId),
    ];
    for (const directory of folders) {
      await assertRealDirectory(directory);
      if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    return folders[3]!;
  }

  /** Квитанция не читается через ссылку и ограничена небольшим служебным размером. */
  private async receipt(path: string): Promise<z.infer<typeof receiptSchema> | undefined> {
    try {
      const meta = await lstat(path);
      if (!meta.isFile() || meta.size > 16384) throw new Error('Некорректная квитанция экспорта.');
      return receiptSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Квитанция экспорта недоступна.', {
        cause: error,
      });
    }
  }

  /** Жёсткая ссылка публикует файл атомарно и никогда не перезаписывает чужое содержимое. */
  private async finish(directory: string, receipt: z.infer<typeof receiptSchema>): Promise<void> {
    const filename = receipt.result.path;
    const suffix = receipt.result.format === 'json' ? '.report.json' : '.md';
    if (dirname(filename) !== directory)
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Путь экспорта не принадлежит проекту.');
    const expected = join(directory, hashFromFilename(filename, suffix) + suffix);
    if (filename !== expected)
      throw new ApplicationError('STORAGE_UNAVAILABLE', 'Некорректный путь экспорта.');
    const temporary = join(directory, receipt.temporary + '.tmp');
    try {
      await lstat(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await link(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const meta = await lstat(filename);
    if (!meta.isFile() || meta.size !== receipt.result.bytes)
      throw new ApplicationError(
        'STORAGE_UNAVAILABLE',
        'Существующий экспорт отличается; перезапись запрещена.',
      );
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const digest = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
      if (digest.digest('hex') !== receipt.digest)
        throw new ApplicationError(
          'STORAGE_UNAVAILABLE',
          'Существующий экспорт отличается; перезапись запрещена.',
        );
    } finally {
      await file.close();
    }
    await syncDirectory(directory);
    await unlink(temporary).catch(() => undefined);
  }
}

/** Выбирает только штатное имя, не позволяя квитанции перейти в другую папку. */
function hashFromFilename(path: string, suffix: string): string {
  const name = path.split(/[\\/]/).at(-1)!;
  const digest = name.slice(0, -suffix.length);
  if (!name.endsWith(suffix) || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error('Некорректное имя экспорта.');
  return digest;
}
