import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { profileSchema } from '../configuration/schema.js';
import { hash, message } from '../shared/primitives.js';
import { applicationIdentity } from '../shared/identity.js';
import { executeProgram } from '../tools/process.js';
import { atomicJson } from '../sessions/files.js';
import { benchmarkOrder, scenarios } from './scenarios.js';
import { benchmarkLimits, benchmarkRoles, createBenchmarkSession } from './session.js';
import { saveBenchmarkReport } from './report.js';
import type {
  BenchmarkReport,
  BenchmarkResult,
  BenchmarkSelection,
  BenchmarkTrial,
} from './types.js';

/** Офлайн-профиль заведомо не содержит рабочих подключений; транспорт заменён подготовленным провайдером. */
export function offlineSelection(): BenchmarkSelection {
  return {
    kind: 'offline',
    profileId: 'offline',
    profile: profileSchema.parse({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'Подготовленный стенд',
      contextTokens: 65536,
      outputTokens: 4096,
      retries: 0,
    }),
  };
}

/** Исполняет один изолированный запуск и доверенную проверку после завершения всего дерева. */
async function runTrial(
  directory: string,
  trial: BenchmarkTrial,
  selection: BenchmarkSelection,
  signal?: AbortSignal,
): Promise<BenchmarkResult> {
  const started = performance.now();
  const scenario = scenarios.find((entry) => entry.id === trial.scenario)!;
  const controller = new AbortController();
  const stop = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const timer = setTimeout(
    () => controller.abort(new Error('Истёк предел времени одного запуска стенда.')),
    benchmarkLimits.trialTimeoutMs,
  );
  timer.unref();
  let session: Awaited<ReturnType<typeof createBenchmarkSession>> | undefined;
  let runId: string | undefined;
  let cancelling: Promise<void> | undefined;
  const cancelRun = () => {
    if (runId && session) {
      cancelling ??= session.app.runtime.cancel(runId);
      void cancelling.catch(() => undefined);
    }
  };
  controller.signal.addEventListener('abort', cancelRun);
  const result: BenchmarkResult = {
    ...trial,
    status: 'failed',
    wallMs: 0,
    checks: [],
    command: process.execPath,
    args: [],
  };
  const measure = async (): Promise<void> => {
    if (!session || !runId) return;
    try {
      result.insights = await session.app.insights.report(runId);
    } catch (error) {
      result.insightsError = message(error);
    }
  };
  try {
    controller.signal.throwIfAborted();
    session = await createBenchmarkSession(
      join(directory, 'runs', String(trial.index).padStart(3, '0')),
      scenario,
      trial.mode,
      selection,
    );
    controller.signal.throwIfAborted();
    const run = await session.app.runtime.start({
      workspace: session.workspace,
      message: `[BENCH:${scenario.id}:all] ${scenario.goal}`,
      requestKey: randomUUID(),
    });
    runId = run.runId;
    result.runId = runId;
    result.configHash = session.app.config.hash;
    result.args = session.args;
    if (controller.signal.aborted) cancelRun();
    await session.app.runtime.wait(runId);
    await cancelling;
    controller.signal.throwIfAborted();
    const state = session.app.runtime.view(runId);
    await measure();
    const verification = await executeProgram(session.command, session.args, {
      workspace: session.workspace,
      signal: controller.signal,
    });
    const artifact = 'runs/' + String(trial.index).padStart(3, '0') + '/verification.json';
    await atomicJson(join(directory, artifact), verification);
    result.verification = {
      artifact,
      exitCode: verification.exitCode,
      stdoutTruncated: verification.stdoutTruncated,
      stderrTruncated: verification.stderrTruncated,
    };
    try {
      const data = JSON.parse(verification.stdout.trim()) as { checks: BenchmarkResult['checks'] };
      if (!Array.isArray(data.checks) || data.checks.length !== scenario.checks.length)
        throw new Error('Неполный ответ проверки');
      result.checks = scenario.checks.map((check, index) => ({
        title: check.title,
        passed: data.checks[index]?.passed === true,
      }));
    } catch {
      result.checks = scenario.checks.map((check) => ({
        title: check.title,
        passed: false,
        error: 'Результат доверенной проверки недоступен.',
      }));
    }
    result.status =
      state.status === 'completed' &&
      verification.exitCode === 0 &&
      result.checks.every((check) => check.passed)
        ? 'passed'
        : 'failed';
    if (state.status !== 'completed')
      result.error = state.error ?? 'Задача остановилась в состоянии ' + state.status;
  } catch (error) {
    result.status = signal?.aborted ? 'cancelled' : 'failed';
    result.error = message(error);
  } finally {
    for (const close of [() => cancelling, () => session?.app.close()]) {
      try {
        await close();
      } catch (error) {
        result.cleanupError = [result.cleanupError, message(error)].filter(Boolean).join('\n');
        result.error = [result.error, message(error)].filter(Boolean).join('\n');
        result.status = signal?.aborted ? 'cancelled' : 'failed';
      }
    }
    if (!result.insights && !result.insightsError) await measure();
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    controller.signal.removeEventListener('abort', cancelRun);
    result.wallMs = Math.max(0, performance.now() - started);
  }
  return result;
}

/** Создаёт новый каталог результатов; отменённый стенд сохраняет выполненные запуски без повторного исполнения. */
export async function runSpecialistBenchmark(options: {
  output: string;
  selection?: BenchmarkSelection;
  confirmedReal?: boolean;
  signal?: AbortSignal;
  onProgress?(trial: BenchmarkTrial, completed: number): void;
}): Promise<{ directory: string; report: BenchmarkReport }> {
  const selection = structuredClone(options.selection ?? offlineSelection());
  if (selection.kind === 'profile' && !options.confirmedReal)
    throw new Error('Реальный профиль требует явного подтверждения 45 запусков.');
  profileSchema.parse(selection.profile);
  const directory = resolve(options.output);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const canonical = await realpath(directory);
  await mkdir(join(canonical, 'runs'));
  const report: BenchmarkReport = {
    schemaVersion: 1,
    benchmarkVersion: 1,
    environment: {
      appVersion: applicationIdentity().version,
      buildId: applicationIdentity().buildId,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    kind: selection.kind,
    profile: {
      id: selection.profileId,
      provider: selection.profile.provider,
      model: selection.profile.model,
      parameterHash: hash(selection.profile),
    },
    learningVersion: 'baseline',
    roles: [...benchmarkRoles],
    limits: { ...benchmarkLimits },
    startedAt: new Date().toISOString(),
    status: 'running',
    planned: 45,
    fixtures: scenarios.map((scenario) => ({
      id: scenario.id,
      hash: hash(scenario),
      checks: scenario.checks.map((check) => check.title),
    })),
    summary: [],
    results: [],
  };
  await saveBenchmarkReport(canonical, report);
  try {
    for (const trial of benchmarkOrder()) {
      if (options.signal?.aborted) break;
      options.onProgress?.(trial, report.results.length);
      const result = await runTrial(canonical, trial, selection, options.signal);
      report.results.push(result);
      await saveBenchmarkReport(canonical, report);
      if (result.cleanupError) {
        report.status = 'failed';
        report.error = result.cleanupError;
        break;
      }
    }
    if (report.status !== 'failed')
      report.status = options.signal?.aborted ? 'cancelled' : 'completed';
  } catch (error) {
    report.status = options.signal?.aborted ? 'cancelled' : 'failed';
    report.error = message(error);
  }
  report.finishedAt = new Date().toISOString();
  await saveBenchmarkReport(canonical, report);
  return { directory: canonical, report };
}
