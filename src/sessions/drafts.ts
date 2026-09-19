import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { id, hash } from '../shared/primitives.js';
import { atomicJson, assertRealDirectory, optionalJson, syncDirectory } from './files.js';
import type { SessionStore } from './ports.js';
import { ResourceNotFoundError } from '../shared/resource-errors.js';

export const taskTextLimit = 100000;
export const draftScopeSchema = z
  .object({
    workspace: z.string(),
    profile: z.string().optional(),
    sessionId: z.string().uuid().optional(),
    expectedParentRunId: z.string().uuid().optional(),
    messageRunId: z.string().uuid().optional(),
    purpose: z.enum(['project.goal', 'project.plan', 'project.message']).optional(),
    projectId: z.string().uuid().optional(),
    stageId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type DraftScope = z.infer<typeof draftScopeSchema>;
export const draftLocationSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid().optional(),
  })
  .strict();
export type DraftLocation = z.infer<typeof draftLocationSchema>;
const draftSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    scope: draftScopeSchema,
    requestKey: z.string().min(1).max(200),
    revision: z.number().int().nonnegative(),
    text: z.string().max(taskTextLimit),
    state: z.enum(['editing', 'pending']),
    expectedProjectRevision: z.number().int().nonnegative().safe().optional(),
    updatedAt: z.string(),
  })
  .strict();
export type TaskDraft = z.infer<typeof draftSchema>;
export type DraftSummary = Omit<TaskDraft, 'text'> & { preview: string };
export const draftUpdateSchema = draftLocationSchema.extend({
  expectedRevision: z.number().int().nonnegative(),
  text: z.string().max(taskTextLimit).optional(),
  state: z.enum(['editing', 'pending']).optional(),
  expectedProjectRevision: z.number().int().nonnegative().safe().optional(),
});

/** Сервис записывает черновики под блокировкой хранилища; версия защищает от второго окна. */
export class DraftStore {
  constructor(private readonly sessions: SessionStore) {}
  private get directory(): string {
    return join(this.sessions.directory, 'drafts');
  }
  /** Формирует путь по проверенным идентификаторам черновика и сессии. */
  private path(location: DraftLocation): string {
    const value = draftLocationSchema.parse(location);
    return join(this.directory, (value.sessionId ?? 'new') + '.' + value.id + '.json');
  }
  /** Возвращает страницу черновиков только указанного назначения и проекта. */
  async list(scope: DraftScope, offset = 0): Promise<{ items: DraftSummary[]; total: number }> {
    draftScopeSchema.parse(scope);
    this.assertMessageScope(scope);
    this.sessions.assertRequestAllowed('', scope.sessionId);
    await assertRealDirectory(this.directory);
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], total: 0 };
      throw error;
    }
    const items: DraftSummary[] = [];
    for (const name of names) {
      if (!name.startsWith((scope.sessionId ?? 'new') + '.') || !name.endsWith('.json')) continue;
      const draft = draftSchema.parse(await optionalJson(join(this.directory, name)));
      if (hash(draft.scope) !== hash(scope)) continue;
      const { text, ...metadata } = draft;
      items.push({ ...metadata, preview: text.replace(/\s+/g, ' ').slice(0, 160) });
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { items: items.slice(offset, offset + 20), total: items.length };
  }
  /** Читает черновик и проверяет, что его беседа не удалена навсегда. */
  async get(location: DraftLocation): Promise<TaskDraft> {
    await assertRealDirectory(this.directory);
    const value = await optionalJson(this.path(location));
    if (!value) throw new ResourceNotFoundError('draft');
    const draft = draftSchema.parse(value);
    this.sessions.assertRequestAllowed(draft.requestKey, draft.scope.sessionId);
    return draft;
  }
  /** Создаёт отдельный черновик с ключом, сохраняемым при повторной отправке. */
  async create(scope: DraftScope, text = '', requestKey = id()): Promise<TaskDraft> {
    this.assertMessageScope(draftScopeSchema.parse(scope));
    this.sessions.assertRequestAllowed(requestKey, scope.sessionId);
    const draft = draftSchema.parse({
      schemaVersion: 1,
      id: id(),
      scope,
      text,
      requestKey,
      revision: 0,
      state: 'editing',
      updatedAt: new Date().toISOString(),
    });
    await assertRealDirectory(this.directory);
    await atomicJson(this.path({ id: draft.id, sessionId: scope.sessionId }), draft);
    return draft;
  }
  /** Сохраняет правку по ожидаемой ревизии; отправленный текст остаётся неизменным. */
  async update(input: z.infer<typeof draftUpdateSchema>): Promise<TaskDraft> {
    const { expectedRevision, text, state, expectedProjectRevision, ...location } =
      draftUpdateSchema.parse(input);
    const draft = await this.get(location);
    if (draft.revision !== expectedRevision)
      throw new Error('Черновик изменён в другом окне. Откройте сохранённую версию заново.');
    if (
      draft.state === 'pending' &&
      ((text !== undefined && text !== draft.text) ||
        state === 'editing' ||
        (expectedProjectRevision !== undefined &&
          expectedProjectRevision !== draft.expectedProjectRevision))
    )
      throw new Error(
        'Запрос уже отправлялся. Сначала проверьте его повторной отправкой с тем же ключом.',
      );
    const next = {
      ...draft,
      text: text ?? draft.text,
      state: state ?? draft.state,
      ...(expectedProjectRevision === undefined ? {} : { expectedProjectRevision }),
      revision: draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (next.state === 'pending' && !next.text.trim())
      throw new Error('Опишите задачу своими словами.');
    await atomicJson(this.path(location), next);
    return next;
  }
  /** Удаляет только прочитанную ревизию, сохраняя правки другого окна. */
  async remove(location: DraftLocation, expectedRevision: number): Promise<void> {
    const draft = await this.get(location);
    if (draft.revision !== expectedRevision)
      throw new Error('Черновик изменён в другом окне. Откройте сохранённую версию заново.');
    await rm(this.path(location));
    await syncDirectory(this.directory);
  }
  /** Перенос отклонённого уточнения создаёт новый ключ; принятый запрос переносить нельзя. */
  async rebase(
    location: DraftLocation,
    expectedRevision: number,
    parentRunId: string,
  ): Promise<TaskDraft> {
    const draft = await this.get(location);
    if (draft.scope.messageRunId || draft.scope.purpose)
      throw new Error('Сообщение активной задаче нельзя перенести в другой запуск.');
    if (draft.revision !== expectedRevision) throw new Error('Черновик изменён в другом окне.');
    if (this.sessions.catalog(true).some((run) => run.requestKey === draft.requestKey))
      throw new Error('Этот запрос уже принят. Проверьте отправку вместо создания новой задачи.');
    const parent = await this.sessions.load(parentRunId);
    if (
      parent.sessionId !== draft.scope.sessionId ||
      parent.deletedAt ||
      !['completed', 'failed', 'cancelled'].includes(parent.status)
    )
      throw new Error('Актуальный ответ пока недоступен для продолжения.');
    const next = await this.create({ ...draft.scope, expectedParentRunId: parent.id }, draft.text);
    await this.remove(location, expectedRevision);
    return next;
  }

  /** Проверяет принадлежность уточнения конкретной задаче, беседе и рабочей папке. */
  private assertMessageScope(scope: DraftScope): void {
    if (scope.purpose || scope.projectId || scope.stageId) {
      if (
        !scope.purpose ||
        scope.sessionId ||
        scope.expectedParentRunId ||
        scope.messageRunId ||
        (scope.purpose !== 'project.goal' && !scope.projectId) ||
        (scope.purpose === 'project.message' ? !scope.stageId : !!scope.stageId)
      )
        throw new Error('Черновик проекта должен относиться к своей цели, плану или этапу.');
    }
    if (!scope.messageRunId) return;
    const run = this.sessions.catalog(true).find((item) => item.id === scope.messageRunId);
    if (!run) throw new ResourceNotFoundError('task');
    if (
      scope.expectedParentRunId ||
      run.sessionId !== scope.sessionId ||
      run.workspace !== scope.workspace
    )
      throw new Error('Черновик сообщения должен относиться к указанной задаче и её папке.');
  }
}

/** Каскад удаляет и незавершённые атомарные копии черновиков выбранной беседы. */
export async function removeSessionDrafts(
  directory: string,
  sessionId: string,
  requestDigests: string[] = [],
): Promise<void> {
  z.string().uuid().parse(sessionId);
  const folder = join(directory, 'drafts');
  await assertRealDirectory(folder);
  try {
    const names = await readdir(folder);
    const prefixes = [sessionId + '.'];
    for (const name of names) {
      if (!name.startsWith('new.') || !name.endsWith('.json') || !requestDigests.length) continue;
      const draft = draftSchema.parse(await optionalJson(join(folder, name)));
      if (requestDigests.includes(hash(draft.requestKey)))
        prefixes.push('new.' + draft.id + '.json');
    }
    for (const name of names)
      if (prefixes.some((prefix) => name.startsWith(prefix)))
        await rm(join(folder, name), { force: true });
    await syncDirectory(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
