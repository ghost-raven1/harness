import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { benchmarkOrder, scenarios } from '../src/benchmark/scenarios.js';
import { BenchmarkProvider } from '../src/benchmark/provider.js';
import { offlineSelection, runSpecialistBenchmark } from '../src/benchmark/runner.js';
import { createBenchmarkSession } from '../src/benchmark/session.js';
import { PolicyService } from '../src/policy/service.js';
import { InsightsService } from '../src/insights/service.js';
import { temporary } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test('матрица содержит 45 запусков с тремя чередующимися повторами каждой пары', () => {
  const order = benchmarkOrder();
  expect(order).toHaveLength(45);
  for (const scenario of scenarios)
    for (const mode of ['solo', 'fixed', 'auto'])
      expect(
        order
          .filter((trial) => trial.scenario === scenario.id && trial.mode === mode)
          .map((trial) => trial.repeat),
      ).toEqual([1, 2, 3]);
  expect(order.slice(0, 3).map((trial) => trial.mode)).toEqual(['solo', 'fixed', 'auto']);
  expect(order.slice(15, 18).map((trial) => trial.mode)).toEqual(['fixed', 'auto', 'solo']);
});

test('офлайн-матрица проходит настоящий runtime и доверенные проверки без сети', async () => {
  const root = await temporary();
  const ordinary = join(root, 'обычные данные');
  await mkdir(ordinary);
  await writeFile(join(ordinary, 'sentinel'), 'не менять');
  vi.stubEnv('HARNESS_STATE_DIR', ordinary);
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Сеть запрещена в офлайн-тесте'));
  const { directory, report } = await runSpecialistBenchmark({ output: join(root, 'результат') });
  expect(report.status).toBe('completed');
  expect(report.results).toHaveLength(45);
  expect(report.summary).toHaveLength(15);
  expect(report.summary.every((entry) => entry.finished === 3 && entry.passed === 3)).toBe(true);
  expect(report.fixtures.every((entry) => /^[a-f0-9]{64}$/.test(entry.hash))).toBe(true);
  expect(report.environment).toMatchObject({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  expect(report.environment.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  expect(report.results.filter((result) => result.status !== 'passed')).toEqual([]);
  expect(new Set(report.results.map((result) => result.runId)).size).toBe(45);
  expect(fetch).not.toHaveBeenCalled();
  expect(await readFile(join(ordinary, 'sentinel'), 'utf8')).toBe('не менять');
  for (const result of report.results) {
    const runRoot = join(directory, 'runs', String(result.index).padStart(3, '0'));
    const record = JSON.parse(
      await readFile(join(runRoot, 'state/runs', result.runId + '.json'), 'utf8'),
    );
    expect(record.learningVersion).toBe('baseline');
    expect(record.config.value.learning.enabled).toBe(false);
    expect(record.config.value.workspaces).toEqual([join(runRoot, 'workspace')]);
    expect(record.config.value.tools.mcp).toEqual([]);
    expect(result.insights?.agents.length).toBeGreaterThan(0);
    expect(result.verification?.exitCode).toBe(0);
    if (result.mode === 'solo') {
      expect(Object.keys(record.agents)).toHaveLength(1);
      expect(record.handoffs).toBe(0);
    }
  }
  expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))).toEqual(report);
  expect(await readFile(join(directory, 'report.md'), 'utf8')).toContain(
    'не доказывает эффективность',
  );
}, 120000);

test('solo запрещает управление ветками политикой, а process.exec ограничен буквальным argv', async () => {
  const root = await temporary();
  const session = await createBenchmarkSession(
    join(root, 'trial'),
    scenarios[0]!,
    'solo',
    offlineSelection(),
  );
  try {
    const policy = new PolicyService();
    for (const role of Object.keys(session.app.config.value.roles)) {
      const agent = { role, authorityRoles: ['coordinator'] };
      expect(
        policy.decide(session.app.config.value, agent, 'agents.delegate', {
          role: 'executor',
          task: 'обход',
        }),
      ).toBe('deny');
      expect(
        policy.decide(session.app.config.value, agent, 'agents.handoff', {
          role: 'executor',
          reason: 'обход',
        }),
      ).toBe('deny');
    }
    await expect(
      session.app.registry.get('process.exec').execute(
        { command: process.execPath, args: ['-e', 'process.exit(0)'] },
        {
          runId: 'unused',
          workspace: session.workspace,
          config: session.app.config.value,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('закреплённую команду');
  } finally {
    await session.app.close();
  }
});

test('отмена действующего запроса сохраняет partial и не повторяет завершённые шаги', async () => {
  const root = await temporary();
  const controller = new AbortController();
  const original = BenchmarkProvider.prototype.generate;
  let requests = 0;
  vi.spyOn(BenchmarkProvider.prototype, 'generate').mockImplementation(async function (
    this: BenchmarkProvider,
    request,
  ) {
    if (++requests === 2) controller.abort(new Error('Отмена тестом'));
    return original.call(this, request);
  });
  const { directory, report } = await runSpecialistBenchmark({
    output: join(root, 'partial'),
    signal: controller.signal,
  });
  expect(report.status).toBe('cancelled');
  expect(report.results).toHaveLength(1);
  expect(report.results[0]?.status).toBe('cancelled');
  expect(requests).toBe(2);
  expect(await readdir(join(directory, 'runs'))).toEqual(['001']);
  const record = JSON.parse(
    await readFile(
      join(directory, 'runs/001/state/runs', report.results[0]?.runId + '.json'),
      'utf8',
    ),
  );
  expect(record.status).toBe('cancelled');
  expect(await readFile(join(directory, 'runs/001/workspace/square.js'), 'utf8')).toBe(
    scenarios[0]?.files['square.js'],
  );
  expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).status).toBe(
    'cancelled',
  );
});

test('реальная модель требует подтверждения, существующая папка результатов не перезаписывается', async () => {
  const root = await temporary();
  const output = join(root, 'results');
  await expect(
    runSpecialistBenchmark({ output, selection: { ...offlineSelection(), kind: 'profile' } }),
  ).rejects.toThrow('явного подтверждения');
  expect(await readdir(root)).toEqual([]);
  await mkdir(output);
  await writeFile(join(output, 'sentinel'), 'сохранить');
  await expect(runSpecialistBenchmark({ output })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('сохранить');
});

test('заявление модели об успехе не заменяет доверенную проверку', async () => {
  const root = await temporary();
  const controller = new AbortController();
  vi.spyOn(BenchmarkProvider.prototype, 'generate').mockResolvedValue({
    text: 'Готово, все проверки прошли!',
    calls: [],
    finish: 'stop',
    usage: { input: 0, output: 0 },
  });
  const { report } = await runSpecialistBenchmark({
    output: join(root, 'unchecked'),
    signal: controller.signal,
    onProgress: (trial) => {
      if (trial.index === 2) controller.abort();
    },
  });
  expect(report.results[0]?.insights?.status).toBe('completed');
  expect(report.results[0]?.status).toBe('failed');
  expect(report.results[0]?.checks.every((check) => !check.passed)).toBe(true);
});

test('недоступная телеметрия не отменяет проверенный результат и не обозначается нулём', async () => {
  const root = await temporary();
  const controller = new AbortController();
  vi.spyOn(InsightsService.prototype, 'report').mockRejectedValue(
    new Error('Измерения недоступны'),
  );
  const { report } = await runSpecialistBenchmark({
    output: join(root, 'no-metrics'),
    signal: controller.signal,
    onProgress: (trial) => {
      if (trial.index === 2) controller.abort();
    },
  });
  expect(report.results[0]?.status).toBe('passed');
  expect(report.results[0]?.insights).toBeUndefined();
  expect(report.summary[0]).toMatchObject({
    passed: 1,
    usage: null,
    retries: null,
    completeness: 'unavailable',
  });
});
