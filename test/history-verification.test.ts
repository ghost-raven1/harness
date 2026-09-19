import { expect, it } from 'vitest';
import { appendFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newAgent } from '../src/agents/service.js';
import { verifyHistory } from '../src/diagnostics/history-verification.js';
import type { JournalEvent, RunRecord } from '../src/sessions/types.js';
import { hash, id } from '../src/shared/primitives.js';
import { fixtureConfig, temporary } from './helpers.js';

/** Создаёт историческую запись напрямую, не запуская исполнителей и восстановление. */
async function storedRun() {
  const directory = await temporary();
  const config = fixtureConfig(directory);
  const agent = newAgent('coordinator', 'PRIVATE_TASK');
  agent.status = 'completed';
  const run: RunRecord = {
    schemaVersion: 1,
    id: id(),
    sessionId: id(),
    requestKey: 'fixture',
    requestHash: hash('fixture'),
    workspace: directory,
    profile: 'test',
    config: { value: config, hash: hash(config) },
    learningVersion: 'baseline',
    status: 'completed',
    rootAgentId: agent.id,
    agents: { [agent.id]: agent },
    invocations: {},
    approvals: {},
    artifacts: [],
    turns: 1,
    handoffs: 0,
    usage: { input: 1, output: 1 },
    createdAt: new Date().toISOString(),
    result: 'PRIVATE_RESPONSE',
  };
  const event: JournalEvent = {
    seq: 1,
    at: run.createdAt,
    type: 'run.completed',
    payload: { secret: 'PRIVATE_TOOL_ARGUMENT' },
    state: run,
  };
  await mkdir(join(directory, 'runs'));
  const path = join(directory, 'runs', run.id + '.jsonl');
  await writeFile(path, JSON.stringify(event) + '\n');
  return { directory, path, event, run };
}

it('проверяет исторический журнал и вывод без изменения источников и раскрытия текста', async () => {
  const { directory, path, run } = await storedRun();
  await mkdir(join(directory, 'output'));
  const outputPath = join(directory, 'output', run.id + '.jsonl');
  await writeFile(
    outputPath,
    JSON.stringify({
      seq: 1,
      at: run.createdAt,
      requestId: id(),
      agentId: run.rootAgentId,
      role: 'coordinator',
      type: 'text',
      text: 'PRIVATE_OUTPUT',
    }) + '\n',
  );
  const before = await readFile(path);
  const outputBefore = await readFile(outputPath);
  const report = await verifyHistory(directory);
  expect(report).toMatchObject({
    healthy: true,
    readOnly: false,
    counts: { runs: 1, journals: 2, records: 2, outputs: 1 },
  });
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(outputPath)).toEqual(outputBefore);
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE_|fixture|coordinator/);
  expect(JSON.stringify(report)).not.toContain(directory);
  expect(JSON.stringify(report)).not.toContain(run.id);
});

it('обнаруживает оборванный хвост, оставляя его побайтно неизменным', async () => {
  const { directory, path } = await storedRun();
  await appendFile(path, '{"seq":2,"state":"PRIVATE_BROKEN');
  const before = await readFile(path);
  const report = await verifyHistory(directory);
  expect(report).toMatchObject({
    healthy: false,
    readOnly: true,
    issues: [{ code: 'JOURNAL_TORN_TAIL', kind: 'run', record: 2 }],
  });
  expect(await readFile(path)).toEqual(before);
});

it('не подменяет повреждённую завершённую строку исправным снимком', async () => {
  const { directory, path, run } = await storedRun();
  await writeFile(join(directory, 'runs', run.id + '.json'), JSON.stringify(run));
  await appendFile(path, 'PRIVATE_COMPLETE_CORRUPTION\n');
  const before = await readFile(path);
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: false,
    issues: [{ code: 'JOURNAL_INVALID_RECORD', kind: 'run', record: 2 }],
  });
  expect(await readFile(path)).toEqual(before);
});

it.each(['version', 'sequence', 'nested'] as const)('различает повреждение %s', async (failure) => {
  const { directory, path, event } = await storedRun();
  const data = JSON.parse(JSON.stringify(event));
  if (failure === 'version') data.state.schemaVersion = 99;
  if (failure === 'sequence') data.seq = 2;
  if (failure === 'nested') data.state.agents[data.state.rootAgentId].messages = 'PRIVATE_INVALID';
  await writeFile(path, JSON.stringify(data) + '\n');
  const report = await verifyHistory(directory);
  expect(report.healthy).toBe(false);
  expect(report.issues[0]?.code).toBe(
    {
      version: 'STORAGE_VERSION_UNSUPPORTED',
      sequence: 'JOURNAL_INVALID_SEQUENCE',
      nested: 'JOURNAL_INVALID_RECORD',
    }[failure],
  );
});

it('отдельно считает неизвестные исходы, не принимая их за повреждение журнала', async () => {
  const { directory, path, event } = await storedRun();
  event.state.status = 'paused';
  event.state.invocations.write = {
    id: 'write',
    agentId: event.state.rootAgentId,
    call: { id: 'call', name: 'fs.write', arguments: '{}' },
    effect: 'write',
    status: 'unknown',
    startedAt: event.at,
  };
  await writeFile(path, JSON.stringify(event) + '\n' + JSON.stringify({ ...event, seq: 2 }) + '\n');
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: true,
    readOnly: false,
    counts: { unresolvedOperations: 1, records: 2 },
  });
});

it('проверяет ссылки опубликованного вывода на существующего агента', async () => {
  const { directory, run } = await storedRun();
  await mkdir(join(directory, 'output'));
  await writeFile(
    join(directory, 'output', run.id + '.jsonl'),
    JSON.stringify({
      seq: 1,
      at: run.createdAt,
      requestId: id(),
      agentId: 'missing',
      role: 'coordinator',
      type: 'started',
    }) + '\n',
  );
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: false,
    issues: [{ kind: 'output', code: 'HISTORY_INVALID_LINK' }],
  });
});

it('обнаруживает цикл продолжений между существующими этапами одной беседы', async () => {
  const { directory, path, event } = await storedRun();
  const second = structuredClone(event);
  second.state.id = id();
  second.state.parentRunId = event.state.id;
  event.state.parentRunId = second.state.id;
  await writeFile(path, JSON.stringify(event) + '\n');
  await writeFile(
    join(directory, 'runs', second.state.id + '.jsonl'),
    JSON.stringify(second) + '\n',
  );
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: false,
    counts: { runs: 2 },
    issues: [{ kind: 'run', code: 'HISTORY_INVALID_LINK' }],
  });
});

it('проверяет старый снимок обучения, не переписывая его в новый журнал', async () => {
  const directory = await temporary();
  const path = join(directory, 'learning.json');
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    activeVersion: 'missing',
    paused: false,
    candidates: {},
    evidence: {},
    reports: {},
    releases: {},
    jobs: [],
    daily: { date: '', tokens: 0 },
  });
  await writeFile(path, snapshot);
  expect(await verifyHistory(directory)).toMatchObject({
    healthy: false,
    issues: [{ kind: 'learning' }],
  });
  expect(await readFile(path, 'utf8')).toBe(snapshot);
  await expect(readFile(join(directory, 'learning.jsonl'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('не читает внешний журнал через символическую ссылку', async () => {
  const { directory, path } = await storedRun();
  const target = await temporary();
  await symlink(
    join(directory, 'runs'),
    join(target, 'runs'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(await verifyHistory(target)).toMatchObject({
    healthy: false,
    issues: [{ code: 'STORAGE_UNSAFE_PATH' }],
  });
  expect(await readFile(path, 'utf8')).toContain('PRIVATE_TASK');
});
