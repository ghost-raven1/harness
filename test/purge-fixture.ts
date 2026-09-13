import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication, type Application } from '../src/interfaces/application.js';
import { dispatch } from '../src/interfaces/routes.js';
import type { FileLearningStore } from '../src/learning/store.js';
import type { PurgePreview } from '../src/sessions/purge.js';
import { cleanup, configDirectory, output, ScriptedProvider, temporary } from './helpers.js';

export const sourceText = 'PRIVATE_SOURCE_66b077ad';
export const privateKey = 'PRIVATE_REQUEST_KEY_11dd7764';

export async function fixture() {
  const root = await temporary(),
    directory = join(root, 'state');
  const configFile = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const provider = new ScriptedProvider((request) =>
    output(
      request.messages.some((item) => item.content.includes(sourceText))
        ? sourceText
        : 'Остальная задача',
    ),
  );
  const app = await createApplication(configFile, directory, provider);
  cleanup(() => app.close());
  const workspace = join(root, 'workspace');
  const first = await app.runtime.start({ message: sourceText, workspace, requestKey: privateKey });
  await app.runtime.wait(first.runId);
  const next = await app.runtime.start({
    message: 'Продолжи проверку',
    workspace,
    sessionId: first.sessionId,
    requestKey: 'followup',
  });
  await app.runtime.wait(next.runId);
  await app.sessions.delete(first.runId);
  const other = await app.runtime.start({
    message: 'Остальная задача',
    workspace,
    requestKey: 'unrelated',
  });
  await app.runtime.wait(other.runId);
  const learning = app.learning.store as FileLearningStore;
  await learning.update((state) => {
    state.evidence.sourceEvidence = {
      id: 'sourceEvidence',
      runId: first.runId,
      agentId: 'root',
      role: 'coordinator',
      kind: 'tool',
      verified: true,
      content: sourceText,
    };
    state.candidates.sourceLesson = {
      id: 'sourceLesson',
      sourceRunId: first.runId,
      workspace,
      role: 'coordinator',
      profile: 'test',
      title: sourceText,
      lesson: sourceText,
      appliesWhen: 'Для проверки',
      evidenceIds: ['sourceEvidence'],
      status: 'published',
      fingerprint: 'source',
    };
    state.reports.sourceLesson = {
      candidateId: 'sourceLesson',
      baselineVersion: 'baseline',
      suiteHash: 'source',
      results: [],
      passed: true,
    };
    state.releases.learned = {
      id: 'learned',
      parentId: 'baseline',
      createdAt: new Date().toISOString(),
      candidateIds: ['sourceLesson'],
    };
    state.activeVersion = 'learned';
    state.jobs.push({
      id: 'sourceJob',
      runId: first.runId,
      role: 'coordinator',
      status: 'done',
      candidateId: 'sourceLesson',
    });
  });
  await app.sessions.artifact(first.runId, sourceText);
  const writer = await app.sessions.output.begin(next.runId, 'root', 'coordinator');
  writer.progress({ type: 'reasoning', text: sourceText });
  await writer.finish(output(sourceText));
  await mkdir(join(directory, 'file-backups', next.runId), { recursive: true });
  await writeFile(
    join(directory, 'file-backups', next.runId, 'backup.json'),
    JSON.stringify({ content: sourceText }),
  );
  await mkdir(join(directory, 'exports'), { recursive: true });
  await writeFile(join(directory, 'exports', 'Урок Harness sourceLesson.md'), sourceText);
  await writeFile(join(workspace, 'project.txt'), 'Файл проекта: ' + sourceText);
  await writeFile(join(workspace, 'Ответ Harness ' + first.runId + '.md'), sourceText);
  return { app, root, directory, configFile, provider, workspace, first, next, other, learning };
}

export async function files(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(result, await files(path));
    else if (item.isFile()) result[path] = await readFile(path, 'utf8');
  }
  return result;
}

export function preview(app: Application, runId: string): Promise<PurgePreview> {
  return dispatch(app, 'runtime.purgePreview', { runId }) as Promise<PurgePreview>;
}
export async function purge(app: Application, runId: string) {
  const plan = await preview(app, runId);
  return dispatch(app, 'runtime.purge', { runId, previewToken: plan.previewToken });
}
