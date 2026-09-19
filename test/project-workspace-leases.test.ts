import { mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WorkspaceLeases, type WorkspaceBlocker } from '../src/projects/workspace-leases.js';
import type { RunRecord } from '../src/sessions/types.js';
import { temporary } from './helpers.js';

/** Проверке доступа нужны только папка и закреплённая принадлежность запуска. */
function run(workspace: string, projectId?: string): RunRecord {
  return { workspace, project: projectId ? { projectId } : undefined } as RunRecord;
}

it('родительские и дочерние папки конфликтуют; соседние проекты независимы', async () => {
  const root = await temporary();
  const first = join(root, 'app');
  const child = join(first, 'src');
  const sibling = join(root, 'app-second');
  await mkdir(child, { recursive: true });
  await mkdir(sibling);
  const leases = new WorkspaceLeases(() => []);
  leases.acquire('first', first);
  leases.acquire('first', first);
  expect(() => leases.acquire('child', child)).toThrow(
    expect.objectContaining({ code: 'PROJECT_CONFLICT' }),
  );
  expect(() => leases.acquire('parent', root)).toThrow();
  leases.acquire('second', sibling);
  expect(leases.busy()).toBe(true);
  leases.release('first');
  leases.acquire('child', child);
  expect(() => leases.acquire('parent', first)).toThrow();
  leases.release('child');
  leases.release('second');
  expect(leases.busy()).toBe(false);
});

it('резерв обычной задачи закрывает гонку до асинхронного создания запуска', async () => {
  const workspace = await temporary();
  const leases = new WorkspaceLeases(() => []);
  const release = leases.reserve({ workspace });
  expect(() => leases.acquire('project', workspace)).toThrow();
  leases.assertWrite(run(workspace));
  release();
  release();
  leases.acquire('project', workspace);
  expect(() => leases.reserve({ workspace })).toThrow();
  expect(() => leases.assertWrite(run(workspace))).toThrow();
  leases.release('project');
});

it('управляемая задача требует своего lease и сохраняет его до завершения исполнителя', async () => {
  const workspace = await temporary();
  const leases = new WorkspaceLeases(() => []);
  expect(() => leases.reserve({ workspace, projectId: 'project' })).toThrow();
  leases.acquire('project', workspace);
  const release = leases.reserve({ workspace, projectId: 'project' });
  leases.assertWrite(run(workspace, 'project'));
  expect(() => leases.release('project')).toThrow();
  expect(() => leases.assertWrite(run(workspace, 'other'))).toThrow();
  release();
  leases.release('project');
  expect(() => leases.assertWrite(run(workspace, 'project'))).toThrow();
  expect(leases.busy()).toBe(false);
});

it('неизвестный исход блокирует даже владельца и повторно проверяется перед записью', async () => {
  const workspace = await temporary();
  let blockers: WorkspaceBlocker[] = [
    { workspace, projectId: 'project', unknown: true, active: false },
  ];
  const leases = new WorkspaceLeases(() => blockers);
  expect(() => leases.acquire('project', workspace)).toThrow('неизвестным результатом');
  blockers = [];
  leases.acquire('project', workspace);
  const release = leases.reserve({ workspace, projectId: 'project' });
  blockers = [{ workspace, projectId: 'project', unknown: false, active: true }];
  leases.assertWrite(run(workspace, 'project'));
  blockers[0]!.unknown = true;
  expect(() => leases.assertWrite(run(workspace, 'project'))).toThrow('неизвестным результатом');
  release();
  leases.release('project');
});

it('каталог активных запусков блокирует другой проект, завершённые задачи не мешают', async () => {
  const workspace = await temporary();
  const blockers = [{ workspace, unknown: false, active: true }];
  const leases = new WorkspaceLeases(() => blockers);
  expect(() => leases.acquire('project', workspace)).toThrow();
  blockers[0]!.active = false;
  leases.acquire('project', workspace);
  leases.release('project');
});

it('realpath объединяет aliases; замена ссылки после резервирования запрещает запись', async () => {
  const root = await temporary();
  const first = join(root, 'first');
  const other = join(root, 'other');
  const alias = join(root, 'alias');
  await mkdir(first);
  await mkdir(other);
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const leases = new WorkspaceLeases(() => []);
  leases.acquire('project', alias);
  expect(() => leases.acquire('duplicate', first)).toThrow();
  const release = leases.reserve({ workspace: alias, projectId: 'project' });
  leases.assertWrite(run(await realpath(alias), 'project'));
  await unlink(alias);
  await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => leases.assertWrite(run(alias, 'project'))).toThrow();
  release();
  leases.release('project');
  await writeFile(join(other, 'unchanged.txt'), 'исходники');
});
