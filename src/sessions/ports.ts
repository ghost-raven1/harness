import type { ModelOutput, ModelProgress } from '../providers/types.js';
import type { Approval, JournalEvent, RunRecord } from './types.js';

/** Служебные настройки и счётчики читаются отдельно от состояния задачи. */
export interface StateFiles {
  read(name: 'usage' | 'iteration-settings'): Promise<unknown | undefined>;
  write(name: 'usage' | 'iteration-settings', value: unknown): Promise<void>;
}

/** Производные метаданные позволяют строить меню без загрузки переписки. */
export interface RunCatalogEntry {
  id: string;
  sessionId: string;
  requestKey: string;
  requestHash: string;
  parentRunId?: string;
  workspace: string;
  profile: string;
  task: string;
  taskTruncated?: boolean;
  status: RunRecord['status'];
  deletedAt?: string;
  createdAt: string;
  seq: number;
  rootAgentId: string;
  learningVersion: string;
  turns: number;
  usage: RunRecord['usage'];
  unknownOutcome: boolean;
  unfinishedOperations: boolean;
  searchHash: string;
  learningEnabled: boolean;
  pendingApprovals: Approval[];
  approvalIds: string[];
  artifacts: RunRecord['artifacts'];
}

/** Чтение каталога не обращается к журналам; полное состояние загружается явно. */
export interface SessionReader {
  get(id: string): RunRecord;
  load(id: string): Promise<RunRecord>;
  pin(id: string): void;
  unpin(id: string): void;
  search(query: string, includeDeleted?: boolean): Promise<Set<string>>;
  catalog(includeDeleted?: boolean): RunCatalogEntry[];
  history(id: string, after: number, limit?: number): Promise<JournalEvent[]>;
  sessionRevision(sessionId: string): string;
}

/** Функция изменения синхронна и исполняется внутри последовательной операции хранилища. */
export interface SessionWriter {
  create(run: RunRecord, expectedSessionRevision?: string): Promise<RunRecord>;
  mutate(
    id: string,
    type: string,
    payload: unknown,
    update: (run: RunRecord) => void,
  ): Promise<RunRecord>;
  delete(id: string): Promise<void>;
  recoverInterrupted(id: string): Promise<void>;
  assertRequestAllowed(requestKey: string, sessionId?: string): void;
}

/** Артефакты доступны отдельно от большого снимка истории запуска. */
export interface ArtifactStore {
  artifact(runId: string, content: string): Promise<string>;
  readArtifact(runId: string, artifactId: string, offset: number, limit: number): Promise<string>;
}

/** Маркер удаления не содержит переписку и запрещает повторный запуск удалённого запроса. */
export interface SessionPurgeRecord {
  schemaVersion: 1;
  sessionId: string;
  runIds: string[];
  requestDigests: string[];
  candidateIds: string[];
  evidenceIds: string[];
  reportIds: string[];
  previewToken: string;
  complete: boolean;
}

/** Обслуживание выполняется владельцем состояния после остановки исполнителей. */
export interface SessionMaintenance {
  readonly directory: string;
  readonly recoveryError: string | undefined;
  assertWritable(): void;
  requireRecovery(error: unknown): void;
  withStateFiles<T>(work: () => Promise<T>): Promise<T>;
  beginMaintenance(check: () => void): Promise<() => void>;
  purgeRecord(runId: string): SessionPurgeRecord | undefined;
  recordPurge(record: SessionPurgeRecord): Promise<void>;
  purgeFiles(record: SessionPurgeRecord): Promise<void>;
}

/** Опубликованный фрагмент вывода модели для отдельной страницы журнала. */
export interface StoredOutputEvent {
  seq: number;
  at: string;
  requestId: string;
  agentId: string;
  role: string;
  type: 'started' | 'text' | 'reasoning' | 'retry' | 'completed' | 'failed' | 'truncated';
  text?: string;
}

/** Поток модели фиксируется отдельно от изменений состояния задачи. */
export interface SessionOutput {
  page(
    runId: string,
    cursor: number,
  ): Promise<{ events: StoredOutputEvent[]; cursor: number; hasMore: boolean }>;
  begin(
    runId: string,
    agentId: string,
    role: string,
  ): Promise<{
    readonly requestId: string;
    progress(event: ModelProgress): void;
    finish(output?: ModelOutput): Promise<void>;
  }>;
  forget(runIds: string[]): Promise<void>;
}

/** Порты хранилища для runtime; конкретный файловый адаптер подключает сборка приложения. */
export interface SessionStore
  extends SessionReader,
    SessionWriter,
    ArtifactStore,
    SessionMaintenance {
  readonly output: SessionOutput;
  readonly stateFiles: StateFiles;
}
