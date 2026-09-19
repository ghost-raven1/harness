import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { scanJournal } from '../sessions/journal.js';
import { validateJournalEvent } from '../sessions/validation.js';
import { outputEventSchema } from '../sessions/output.js';
import { validateLearningState } from '../learning/state-schema.js';
import { readPurgeRecords } from '../sessions/purge-records.js';
import type { RunRecord } from '../sessions/types.js';
import {
  historyIssueCodeSchema,
  type HistoryIssue,
  type HistoryVerificationReport,
} from './history-types.js';

const learningEventSchema = z.object({
  seq: z.number().int().positive(),
  state: z.unknown(),
});

type RunLinks = Pick<RunRecord, 'sessionId' | 'workspace' | 'parentRunId'> & {
  agents: Set<string>;
};

/** Передаёт только код: исходный текст исключения может содержать ключи или пользовательские пути. */
function issueCode(error: unknown): HistoryIssue['code'] {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const known = historyIssueCodeSchema.safeParse(code);
  if (known.success) return known.data;
  if (code === 'JOURNAL_CORRUPT_RECORD' || code === 'JOURNAL_RECORD_TOO_LARGE')
    return 'JOURNAL_INVALID_RECORD';
  if (
    error instanceof Error &&
    ['JOURNAL_INVALID_REFERENCE', 'LEARNING_INVALID_REFERENCE'].includes(error.message)
  )
    return 'HISTORY_INVALID_LINK';
  if (error instanceof Error && error.message === 'JOURNAL_INVALID_SEQUENCE')
    return 'JOURNAL_INVALID_SEQUENCE';
  if (typeof code === 'string') return 'STORAGE_UNAVAILABLE';
  return 'JOURNAL_INVALID_RECORD';
}

/** Отличает неизвестный формат от повреждения записи поддерживаемой версии. */
function assertVersion(value: unknown): void {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw Object.assign(new Error('Unsupported storage version'), {
      code: 'STORAGE_VERSION_UNSUPPORTED',
    });
  }
}

/** Проверяет номер до разбора содержимого, чтобы диагностика различала разрыв последовательности. */
function assertSequence(value: unknown, expected: number): void {
  if (!value || typeof value !== 'object' || !('seq' in value) || value.seq !== expected) {
    throw Object.assign(new Error('Invalid journal sequence'), {
      code: 'JOURNAL_INVALID_SEQUENCE',
    });
  }
}

/** Не позволяет проверке читать внешний файл через подменённый внутренний каталог или ссылку. */
async function safePath(path: string, directory: boolean): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)
    ) {
      throw Object.assign(new Error('Unsafe state path'), { code: 'STORAGE_UNSAFE_PATH' });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Проверяет журналы потоково, не восстанавливает хвосты и не записывает снимки или индексы. */
export async function verifyHistory(directory: string): Promise<HistoryVerificationReport> {
  const report: HistoryVerificationReport = {
    checkedAt: new Date().toISOString(),
    healthy: true,
    readOnly: false,
    counts: { journals: 0, records: 0, runs: 0, outputs: 0, learning: 0, unresolvedOperations: 0 },
    issues: [],
  };
  const runs = new Map<string, RunLinks>();

  /** Добавляет только безопасные структурные сведения об ошибке. */
  function recordIssue(
    error: unknown,
    kind: HistoryIssue['kind'],
    record?: number,
    runId?: string,
  ): void {
    report.healthy = false;
    report.readOnly = true;
    report.issues.push({
      code: issueCode(error),
      kind,
      ...(record ? { record } : {}),
      ...(runId && z.string().uuid().safeParse(runId).success ? { runId } : {}),
    });
  }

  /** Перечисляет файлы нужного слоя, считая отсутствующий каталог пустой историей. */
  async function names(folder: string): Promise<string[]> {
    const path = join(directory, folder);
    try {
      if (!(await safePath(path, true))) return [];
      return (await readdir(path)).filter((name) => name.endsWith('.jsonl')).sort();
    } catch (error) {
      recordIssue(error, 'storage');
      return [];
    }
  }

  try {
    if (!(await safePath(directory, true))) return report;
  } catch (error) {
    recordIssue(error, 'storage');
    return report;
  }

  let purged: Set<string>;
  try {
    purged = new Set((await readPurgeRecords(directory)).flatMap((record) => record.runIds));
  } catch (error) {
    recordIssue(error, 'storage');
    return report;
  }

  for (const name of await names('runs')) {
    const runId = name.slice(0, -6);
    // Намерение удаления важнее оставшихся файлов после сбоя очистки.
    if (purged.has(runId)) continue;
    const path = join(directory, 'runs', name);
    let next = 1;
    let latest: RunRecord | undefined;
    report.counts.journals++;
    try {
      if (!(await safePath(path, false))) continue;
      for await (const row of scanJournal<unknown>(path)) {
        assertSequence(row.value, next);
        const state = (row.value as { state?: unknown }).state;
        assertVersion(state);
        latest = validateJournalEvent(row.value, next, runId).state;
        report.counts.records++;
        next++;
      }
      if (!latest) throw new Error('Empty run journal');
      report.counts.runs++;
      report.counts.unresolvedOperations += Object.values(latest.invocations).filter(
        (item) =>
          item.status === 'unknown' || (item.status === 'started' && item.effect === 'write'),
      ).length;
      runs.set(runId, {
        sessionId: latest.sessionId,
        workspace: latest.workspace,
        parentRunId: latest.parentRunId,
        agents: new Set(Object.keys(latest.agents)),
      });
    } catch (error) {
      recordIssue(error, 'run', next, runId);
    }
  }

  for (const [runId, run] of runs) {
    if (!run.parentRunId) continue;
    const parent = runs.get(run.parentRunId);
    if (!parent || parent.sessionId !== run.sessionId || parent.workspace !== run.workspace)
      recordIssue({ code: 'HISTORY_INVALID_LINK' }, 'run', undefined, runId);
  }
  const checkedChains = new Set<string>();
  for (const runId of runs.keys()) {
    const chain = new Set<string>();
    let current: string | undefined = runId;
    while (current && runs.has(current) && !checkedChains.has(current)) {
      if (chain.has(current)) {
        recordIssue({ code: 'HISTORY_INVALID_LINK' }, 'run', undefined, runId);
        break;
      }
      chain.add(current);
      current = runs.get(current)?.parentRunId;
    }
    for (const visited of chain) checkedChains.add(visited);
  }

  for (const name of await names('output')) {
    if (purged.has(name.slice(0, -6))) continue;
    const path = join(directory, 'output', name);
    const run = runs.get(name.slice(0, -6));
    let next = 1;
    report.counts.journals++;
    try {
      if (!(await safePath(path, false))) continue;
      if (!run) throw Object.assign(new Error('Unknown run'), { code: 'HISTORY_INVALID_LINK' });
      for await (const row of scanJournal<unknown>(path)) {
        assertSequence(row.value, next);
        const event = outputEventSchema.parse(row.value);
        if (!run.agents.has(event.agentId))
          throw Object.assign(new Error('Unknown agent'), { code: 'HISTORY_INVALID_LINK' });
        report.counts.records++;
        report.counts.outputs++;
        next++;
      }
    } catch (error) {
      recordIssue(error, 'output', next, name.slice(0, -6));
    }
  }

  let learningRecords = 0;
  try {
    const path = join(directory, 'learning.jsonl');
    if (await safePath(path, false)) {
      report.counts.journals++;
      for await (const row of scanJournal<unknown>(path)) {
        assertSequence(row.value, learningRecords + 1);
        const event = learningEventSchema.parse(row.value);
        assertVersion(event.state);
        validateLearningState(event.state);
        report.counts.records++;
        report.counts.learning++;
        learningRecords++;
      }
    }
    // Старые установки могли сохранить обучение только в снимке; проверка его не преобразует.
    const snapshot = join(directory, 'learning.json');
    if (!learningRecords && (await safePath(snapshot, false))) {
      const state: unknown = JSON.parse(await readFile(snapshot, 'utf8'));
      assertVersion(state);
      validateLearningState(state);
      report.counts.learning++;
    }
  } catch (error) {
    recordIssue(error, 'learning', learningRecords + 1);
  }
  return report;
}
