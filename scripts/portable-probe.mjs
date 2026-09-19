import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';

const root = process.argv[2];
const load = (path) => import(pathToFileURL(join(root, 'dist', path)).href);
const require = createRequire(join(root, 'package.json'));
const execute = promisify(execFile);

/** Весь учебный сценарий исполняется кодом распакованного ZIP, без сети и пользовательских секретов. */
async function probe() {
  assert.equal(globalThis.__harnessPortableOffline, true);
  assert.throws(() => net.connect({ host: '127.0.0.1', port: 1 }), /NETWORK_DISABLED/);
  await assert.rejects(fetch('https://example.invalid'), /NETWORK_DISABLED/);
  const pkg = require('./package.json');
  const manifest = require('./portable-manifest.json');
  assert.equal(process.platform, manifest.nodePlatform);
  assert.equal(process.arch, manifest.arch);
  assert.equal(process.version, 'v' + (await readFile(join(root, '.nvmrc'), 'utf8')).trim());
  const keyring = require('@napi-rs/keyring');
  assert.equal(typeof keyring.AsyncEntry, 'function');
  for (const name of ['typescript', 'vitest', 'vite', 'npm'])
    await assert.rejects(access(join(root, 'node_modules', name, 'package.json')), {
      code: 'ENOENT',
    });
  const { codexExecutable } = await load('providers/codex/connection.js');
  const executable = codexExecutable();
  assert.ok(
    executable.startsWith(join(root, 'node_modules') + (process.platform === 'win32' ? '\\' : '/')),
  );
  const codex = await execute(executable, ['--version'], { timeout: 30000, windowsHide: true });
  assert.ok(codex.stdout.includes(pkg.dependencies['@openai/codex']));
  const { startDemoSession } = await load('interfaces/commands/demo.js');
  const { demoGoal, demoTitle, demoCorrect } = await load('providers/demo-provider.js');
  const session = await startDemoSession();
  const request = session.request;
  const mutation = (project, key) => ({
    projectId: project.projectId,
    expectedRevision: project.revision,
    requestKey: key,
  });
  let report;
  try {
    let project = await request('projects.create', {
      title: demoTitle,
      goal: demoGoal,
      workspace: session.workspace,
      profile: 'demo',
      requestKey: 'portable-create',
    });
    const wait = async (statuses) => {
      const deadline = Date.now() + 90000;
      while (true) {
        project = await request('projects.detail', { projectId: project.projectId });
        if (!statuses.includes(project.status)) return;
        if (Date.now() >= deadline)
          throw new Error('Учебный проект не завершил переход: ' + project.status);
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    await request('projects.plan', mutation(project, 'portable-plan'));
    await wait(['planning']);
    assert.equal(project.status, 'ready', project.reason);
    await request('projects.acceptPlan', {
      ...mutation(project, 'portable-plan-accept'),
      expectedPlanVersion: project.planVersion,
    });
    await wait(['running', 'pausing']);
    assert.equal(project.status, 'review', project.reason);
    assert.deepEqual(
      project.reports.map((entry) => entry.status),
      ['failed', 'failed', 'passed', 'passed'],
    );
    assert.equal(await readFile(join(session.workspace, 'price.js'), 'utf8'), demoCorrect);
    const intervals = await request('projects.changeSets', { projectId: project.projectId });
    const interval = intervals.items.find(
      (entry) => entry.kind === 'project' && entry.outcome === 'complete',
    );
    assert.ok(interval, 'Нет итогового интервала изменений');
    const changes = await request('projects.changes', {
      projectId: project.projectId,
      changeSetId: interval.id,
    });
    const file = changes.items.find((entry) => entry.path === 'price.js');
    assert.ok(file);
    const diff = await request('projects.fileChange', {
      projectId: project.projectId,
      changeSetId: interval.id,
      fileId: file.fileId,
      view: 'diff',
    });
    assert.equal(diff.state, 'available');
    assert.match(diff.text, /price \* quantity/);
    const review = await request('projects.review', { projectId: project.projectId });
    assert.equal(review.canAccept, true, review.blockers.join('\n'));
    project = await request('projects.accept', {
      ...mutation(project, 'portable-accept'),
      expectedResultRevision: project.resultRevision,
    });
    assert.equal(project.status, 'completed');
    const input = {
      projectId: project.projectId,
      expectedRevision: project.revision,
      format: 'json',
      includeLogs: true,
      includeDiffs: true,
    };
    const preview = await request('projects.exportPreview', input);
    const exported = await request('projects.exportReport', {
      ...input,
      requestKey: 'portable-export',
      previewToken: preview.previewToken,
    });
    assert.match(await readFile(exported.path, 'utf8'), /price \* quantity/);
    report = {
      nativeCodex: codex.stdout.trim(),
      keyringNativeLoaded: true,
      keyringSecretAccess: false,
      demo: {
        ipc: true,
        checks: project.reports.map((entry) => entry.status),
        diff: true,
        accepted: true,
        export: true,
      },
      networkDisabled: true,
      node: process.version,
      nodePlatform: process.platform,
      arch: process.arch,
    };
  } finally {
    await session.close();
  }
  await assert.rejects(access(session.root), { code: 'ENOENT' });
  report.demo.cleaned = true;
  return report;
}

console.log(JSON.stringify(await probe()));
