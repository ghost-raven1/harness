import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appendJournal, readJournal } from '../sessions/journal.js';
import { atomicText, optionalJson, writeSnapshot } from '../sessions/files.js';
import { removeLearningTemps, type PurgeRecord } from '../sessions/purge-records.js';
import { eraseLearningSources } from './purge.js';
import { clone, Serial } from '../shared/primitives.js';
import type { LearningState, LearningStore } from './types.js';

/** Журнал обучения восстанавливает очередь и версии независимо от свежести снимка. */
export class FileLearningStore implements LearningStore {
  private readonly serial = new Serial();
  private sequence = 0;
  private maintenance = false;
  private state: LearningState = {
    schemaVersion: 1,
    activeVersion: 'baseline',
    paused: false,
    candidates: {},
    evidence: {},
    reports: {},
    releases: {
      baseline: { id: 'baseline', createdAt: new Date(0).toISOString(), candidateIds: [] },
    },
    jobs: [],
    daily: { date: '', tokens: 0 },
  };
  /** Привязывает журнал и снимок обучения к каталогу состояния сервиса. */
  constructor(private readonly directory: string) {}
  /** Восстанавливает последнее состояние из журнала, используя снимок лишь при его отсутствии. */
  async initialize(): Promise<void> {
    const events = await readJournal<{ seq: number; state: LearningState }>(
      join(this.directory, 'learning.jsonl'),
    );
    for (const [index, event] of events.entries()) {
      if (event.seq !== index + 1 || event.state.schemaVersion !== 1) {
        throw new Error('Corrupt learning journal');
      }
    }
    this.sequence = events.length;
    const journalState = events.at(-1)?.state;
    const stored =
      journalState ?? (await optionalJson<LearningState>(join(this.directory, 'learning.json')));
    if (stored) {
      if (stored.schemaVersion !== 1 || !stored.releases[stored.activeVersion])
        throw new Error('Unsupported learning state');
      this.state = stored;
    }
  }
  /** Возвращает копию, которую читатель не может незаметно изменить в хранилище. */
  read(): LearningState {
    return clone(this.state);
  }
  /** Последовательно фиксирует изменения в журнале до обновления зеркального снимка. */
  update(change: (state: LearningState) => void): Promise<void> {
    return this.serial.run(async () => {
      if (this.maintenance)
        throw new Error('Удаляется беседа. Изменение обучения временно недоступно.');
      const next = this.read();
      change(next);
      if (isDeepStrictEqual(next, this.state)) return;
      await appendJournal(join(this.directory, 'learning.jsonl'), {
        seq: this.sequence + 1,
        at: new Date().toISOString(),
        type: 'learning.updated',
        state: next,
      });
      this.sequence++;
      this.state = next;
      await writeSnapshot(join(this.directory, 'learning.json'), next);
    });
  }
  /** Блокирует новые изменения на время очистки и возвращает функцию снятия блокировки. */
  beginMaintenance(): Promise<() => void> {
    return this.serial.run(async () => {
      if (this.maintenance) throw new Error('Удаляется беседа. Дождитесь завершения удаления.');
      this.maintenance = true;
      return () => {
        this.maintenance = false;
      };
    });
  }
  /** Заменяет весь журнал очищенным состоянием: append оставил бы удалённые тексты на диске. */
  purge(record: PurgeRecord): Promise<void> {
    return this.serial.run(async () => {
      const next = this.read();
      eraseLearningSources(next, record);
      await this.replace(next, 'learning.sources_removed');
    });
  }
  /** Очищает выбранный слой, сохраняя дневной расход и настройку паузы обучения. */
  reset(options: { forgetKnowledge: boolean; runIds: string[] }): Promise<void> {
    return this.serial.run(async () => {
      const next = this.read();
      if (options.forgetKnowledge) {
        next.activeVersion = 'baseline';
        next.candidates = {};
        next.evidence = {};
        next.reports = {};
        next.releases = {
          baseline: { id: 'baseline', createdAt: new Date(0).toISOString(), candidateIds: [] },
        };
        next.jobs = [];
        // Старые сохранённые задачи не должны заново наполнить обучение при запуске сервиса.
        next.ignoredRunIds = [
          ...new Set([...(next.ignoredRunIds ?? []), ...options.runIds]),
        ].sort();
      } else {
        const removed = new Set(options.runIds);
        next.jobs = next.jobs.filter((job) => !removed.has(job.runId));
      }
      await this.replace(
        next,
        options.forgetKnowledge ? 'learning.reset' : 'learning.tasks_removed',
      );
    });
  }
  /** Заменяет историю очищенным состоянием, затем обновляет снимок и удаляет временные копии. */
  private async replace(next: LearningState, type: string): Promise<void> {
    await atomicText(
      join(this.directory, 'learning.jsonl'),
      JSON.stringify({
        seq: 1,
        at: new Date().toISOString(),
        type,
        state: next,
      }) + '\n',
    );
    this.sequence = 1;
    this.state = next;
    await writeSnapshot(join(this.directory, 'learning.json'), next);
    await removeLearningTemps(this.directory);
  }
  /** Выбирает применимые уроки из закреплённого выпуска, включая выпуск уже начатой задачи. */
  lessons(version: string, workspace: string, role: string, profile: string): string[] {
    const release = this.state.releases[version];
    if (!release) throw new Error('Unknown learning version: ' + version);
    // Начатый запуск сохраняет выбранную версию даже после последующего отката.
    return release.candidateIds
      .map((id) => this.state.candidates[id]!)
      .filter(
        (item) => item.workspace === workspace && item.role === role && item.profile === profile,
      )
      .map((item) => item.appliesWhen + ': ' + item.lesson);
  }
}
