import type { Command } from 'commander';
import { note } from '../ui.js';
import type { CliContext, LearningStatusView } from '../types.js';
import { learningVersionLabel } from '../guided/learning-labels.js';
import { lessonLabels } from '../guided/knowledge-format.js';

/** Показывает состояние обучения, расход за текущие сутки UTC и последние кандидаты. */
export async function showLearning(context: CliContext): Promise<void> {
  const state = await context.request<LearningStatusView>('learning.status');
  if (context.json() || !process.stdout.isTTY) {
    context.output(state);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const usedTokens = state.daily.date === today ? state.daily.tokens : 0;
  note(
    [
      state.enabled
        ? state.paused
          ? 'Очередь приостановлена'
          : 'Обучение включено'
        : 'Обучение выключено в конфигурации',
      state.evaluationReady
        ? 'Контрольный набор настроен; область каждого урока проверяется отдельно'
        : 'Нет контрольного набора: автоматическое применение уроков недоступно',
      'Активная версия: ' + learningVersionLabel(state.activeVersion),
      'Токены сегодня (UTC): ' + usedTokens,
      'В очереди: ' + state.jobs.filter((job) => job.status === 'queued').length,
      'Кандидатов: ' + state.candidates.length,
      ...state.candidates
        .slice(-5)
        .map(
          (candidate) =>
            '\n' +
            candidate.title +
            '\n' +
            lessonLabels[candidate.status] +
            ' · ' +
            candidate.id +
            (candidate.reason ? '\n' + candidate.reason : ''),
        ),
      state.candidates.length
        ? '\nПодробнее: harness learning inspect <ID>'
        : '\nУроки появятся после подтверждения и оценки.',
    ].join('\n'),
    'Самообучение',
  );
}

/** Команды опыта отделены от запуска задач и всегда доступны в машинном режиме. */
export function registerLearningCommands(program: Command, context: CliContext): void {
  const learning = program.command('learning').description('Опыт, проверка изменений и откат');
  learning
    .command('status')
    .description('Активная версия, очередь и расход токенов')
    .action(() => showLearning(context));
  learning
    .command('inspect <id>')
    .description('Урок, доказательства и оценка')
    .action(async (id: string) =>
      context.output(await context.request('learning.inspect', { id })),
    );
  learning
    .command('pause')
    .description('Приостановить обучение')
    .action(async () => context.output(await context.request('learning.pause')));
  learning
    .command('resume')
    .description('Продолжить обучение')
    .action(async () => context.output(await context.request('learning.resume')));
  learning
    .command('rollback')
    .description('Откатить активный выпуск')
    .requiredOption('--reason <text>', 'причина отката')
    .action(async (options: { reason: string }) =>
      context.output(await context.request('learning.rollback', options)),
    );
  learning
    .command('feedback <runId>')
    .description('Записать проверенный человеком результат')
    .requiredOption('--text <text>', 'подтверждённый результат или описание регрессии')
    .option('--negative', 'отрицательная оценка')
    .option('--candidate <id>', 'урок, вызвавший регрессию')
    .action(
      async (runId: string, options: { text: string; negative?: boolean; candidate?: string }) => {
        context.output(
          await context.request('learning.feedback', {
            runId,
            positive: !options.negative,
            text: options.text,
            candidateId: options.candidate,
          }),
        );
      },
    );
}
