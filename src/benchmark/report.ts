import { join } from 'node:path';
import { atomicJson, atomicText } from '../sessions/files.js';
import type { BenchmarkReport, BenchmarkSelection } from './types.js';
import { benchmarkRoles, benchmarkLimits } from './session.js';
import { scenarios } from './scenarios.js';

/** Предпросмотр показывает объём запусков, а не выдуманное число будущих API-запросов. */
export function benchmarkPreview(selection: BenchmarkSelection): string {
  return [
    selection.kind === 'offline'
      ? 'Офлайн-стенд: подготовленный провайдер, без сети и API-ключей.'
      : `Реальная модель: ${selection.profileId} · ${selection.profile.provider} · ${selection.profile.model}. Возможен расход по условиям провайдера.`,
    '5 сценариев × 3 режима × 3 повтора = 45 отдельных запусков. Число запросов модели зависит от её ответов.',
    ...scenarios.map(
      (scenario) => `${scenario.title}: ${scenario.checks.map((check) => check.title).join('; ')}`,
    ),
    'Режимы: один агент; фиксированный начальный план; автоматический выбор команды.',
    'Команда стенда: ' +
      benchmarkRoles.join(', ') +
      '. Обычные пользовательские роли не оцениваются.',
    'Проверка каждого запуска: ' +
      JSON.stringify([
        process.execPath,
        '--experimental-vm-modules',
        '<запуск>/verify.mjs',
        '<запуск>/workspace',
      ]),
    `Пределы: ${benchmarkLimits.agents} агента, глубина ${benchmarkLimits.depth}, ${benchmarkLimits.modelConcurrency} model-запроса одновременно, ${benchmarkLimits.turns} шагов, ${benchmarkLimits.trialTimeoutMs / 1000} секунд на запуск.`,
    'Конфигурация и профиль закреплены. Обучение выключено, learningVersion=baseline. Каждый запуск получает чистую отдельную папку и состояние.',
    'Ctrl+C останавливает только исполнителей стенда и сохраняет частичный JSON/Markdown-отчёт. Завершённые действия не повторяются.',
  ].join('\n');
}

/** Публикует JSON как источник отчёта и человекочитаемый Markdown без дополнительных запросов модели. */
export async function saveBenchmarkReport(
  directory: string,
  report: BenchmarkReport,
): Promise<void> {
  report.summary = scenarios.flatMap((scenario) =>
    (['solo', 'fixed', 'auto'] as const).map((mode) => {
      const trials = report.results.filter(
        (entry) => entry.scenario === scenario.id && entry.mode === mode,
      );
      const measured = trials.flatMap((entry) => (entry.insights ? [entry.insights] : []));
      const usage = measured.length
        ? {
            provider: { input: 0, output: 0, requests: 0 },
            estimate: { input: 0, output: 0, requests: 0 },
            unavailable: 0,
          }
        : null;
      for (const insight of measured) {
        for (const source of ['provider', 'estimate'] as const)
          for (const key of ['input', 'output', 'requests'] as const)
            usage![source][key] += insight.usage[source][key];
        usage!.unavailable += insight.usage.unavailable;
      }
      const finished = trials.filter((entry) => entry.status !== 'cancelled');
      return {
        scenario: scenario.id,
        mode,
        finished: finished.length,
        passed: trials.filter((entry) => entry.status === 'passed').length,
        failed: trials.filter((entry) => entry.status === 'failed').length,
        cancelled: trials.filter((entry) => entry.status === 'cancelled').length,
        meanWallMs: finished.length
          ? finished.reduce((total, entry) => total + entry.wallMs, 0) / finished.length
          : null,
        retries: measured.length
          ? measured.reduce((total, entry) => total + entry.retries, 0)
          : null,
        usage,
        completeness: !measured.length
          ? ('unavailable' as const)
          : measured.length !== trials.length ||
              trials.length !== 3 ||
              measured.some((entry) => entry.completeness !== 'complete')
            ? ('partial' as const)
            : ('complete' as const),
      };
    }),
  );
  const rows = report.results.map((entry) => {
    const usage = entry.insights?.usage;
    return `| ${entry.index} | ${entry.scenario} | ${entry.mode} | ${entry.repeat} | ${entry.status} | ${entry.wallMs.toFixed(1)} | ${entry.insights?.retries ?? '—'} | ${usage?.provider.requests ? `${usage.provider.input}/${usage.provider.output}` : '—'} | ${usage?.estimate.requests ? `${usage.estimate.input}/${usage.estimate.output}` : '—'} | ${entry.insights?.completeness ?? 'unavailable'} |`;
  });
  const details = report.results.flatMap((entry) => [
    `\n### ${entry.index}. ${entry.scenario} · ${entry.mode} · повтор ${entry.repeat}`,
    `Состояние: ${entry.status}. Ошибка: ${entry.error ?? 'нет'}.`,
    ...entry.checks.map(
      (check) =>
        `- ${check.passed ? 'Пройдена' : 'Провалена'}: ${check.title}${check.error ? ' — ' + check.error : ''}`,
    ),
    `Недоступный расход: ${entry.insights?.usage.unavailable ?? 'нет измерений'}.`,
    ...(entry.verification
      ? [
          `Код проверки: ${entry.verification.exitCode ?? 'нет'}. Журнал: ${entry.verification.artifact}.`,
        ]
      : []),
    ...(entry.insightsError ? ['Измерения недоступны: ' + entry.insightsError] : []),
    'Команда проверки: `' +
      JSON.stringify([entry.command, ...entry.args]).replaceAll('`', '\\`') +
      '`',
  ]);
  const markdown = [
    '# Сравнение специалистов Harness',
    report.kind === 'offline'
      ? '**Подготовленный офлайн-сценарий проверяет механизм стенда. Он не доказывает эффективность моделей или специалистов.**'
      : 'Результаты относятся только к закреплённому профилю, сценариям и команде стенда.',
    `Состояние: ${report.status}. Завершено ${report.results.length} из ${report.planned}.`,
    `Среда: Harness ${report.environment.appVersion}; сборка ${report.environment.buildId ?? 'исходники без ID сборки'}; Node ${report.environment.node}; ${report.environment.platform}/${report.environment.arch}.`,
    `Модель: ${report.profile.provider} / ${report.profile.model}. Команда стенда: ${report.roles.join(', ')}; обычные роли пользователя не оцениваются.`,
    'Токены указаны вход/выход. Provider и estimate представлены раздельно; отсутствие данных не заменено нулём.',
    'Wall включает подготовку изолированного приложения, работу, доверенную проверку и остановку. activeMs в JSON содержит измеренное время работы runtime отдельно.',
    [
      '| Сценарий | Режим | Завершено из 3 | Пройдено | Провалено | Среднее wall, мс | Полнота |',
      '|---|---|---|---|---|---|---|',
      ...report.summary.map(
        (entry) =>
          `| ${entry.scenario} | ${entry.mode} | ${entry.finished} | ${entry.passed} | ${entry.failed} | ${entry.meanWallMs?.toFixed(1) ?? '—'} | ${entry.completeness} |`,
      ),
    ].join('\n'),
    [
      '| № | Сценарий | Режим | Повтор | Результат | Wall, мс | Retries | Provider | Estimate | Полнота |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...rows,
    ].join('\n'),
    ...details,
    ...(report.error ? ['\nОшибка стенда: ' + report.error] : []),
  ].join('\n\n');
  await atomicJson(join(directory, 'report.json'), report);
  await atomicText(join(directory, 'report.md'), markdown + '\n');
}
