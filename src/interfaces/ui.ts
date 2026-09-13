import { showFilePreview, type FilePreview } from './guided/file-preview.js';
import * as prompts from '@clack/prompts';
import { learningVersionLabel } from './guided/learning-labels.js';
import color from 'picocolors';
import wrapAnsi from 'wrap-ansi';
import type { Approval } from '../sessions/types.js';
import { rpc } from './ipc.js';
import { liveSelect } from './guided/live-select.js';
import { liveConfirm } from './guided/live-confirm.js';
import { commandPage } from './guided/screen.js';

import type { StatusView } from './types.js';
export type { StatusView } from './types.js';

export const labels: Record<string, string> = {
  running: 'В работе',
  waiting: 'Ожидание',
  awaiting_approval: 'Нужно разрешение',
  paused: 'Приостановлено',
  completed: 'Ответ получен',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};
/** Укладывает карточку в ширину терминала, сохраняя весь текст длинных аргументов. */
export function note(content: string, title: string): void {
  const columns = process.stdout.columns || 80;
  const options = { hard: true, trim: false };
  if (columns < 24) {
    prompts.log.message(wrapAnsi(title + '\n' + content, Math.max(1, columns - 3), options));
    return;
  }
  const width = columns - 6;
  const titleLines = wrapAnsi(title, width - 1, options).split('\n');
  const heading = titleLines[0] + (titleLines.length > 1 ? '…' : '');
  prompts.note(wrapAnsi(content, width, options), heading);
}

/** Преобразует отмену интерактивного выбора в единый сигнал возврата. */
export function selected<T>(value: T | symbol): T {
  if (typeof value === 'symbol' || prompts.isCancel(value)) {
    prompts.cancel('Действие отменено');
    throw new Error('INTERACTIVE_CANCEL');
  }
  return value as T;
}
/** Выводит машинный JSON либо представление для терминала. */
export function print(value: unknown, json: boolean): void {
  if (json) process.stdout.write(JSON.stringify(value) + '\n');
  else if (!process.stdout.isTTY) process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  else note(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'Результат');
}
/** Показывает краткое состояние задачи, результат и причину остановки. */
export function statusCard(status: StatusView): void {
  const paint =
    status.status === 'completed'
      ? color.green
      : ['failed', 'cancelled'].includes(status.status)
        ? color.red
        : color.cyan;
  const lines = [
    paint(labels[status.status] ?? status.status) + '  ' + color.dim(status.runId),
    'Модель: ' + status.profile + '   Итерации: ' + status.turns,
    'Токены: ' + status.usage.input + ' вход / ' + status.usage.output + ' выход',
    'Опыт: ' + learningVersionLabel(status.learningVersion),
    '',
    ...status.agents.map(
      (agent) => '  ' + color.cyan(agent.role.padEnd(14)) + (labels[agent.status] ?? agent.status),
    ),
  ];
  if (status.approvals.length)
    lines.push(
      '',
      color.yellow('Ожидают решения: ' + status.approvals.length),
      'Откройте второй терминал: harness approvals',
    );
  if (status.unknownInvocations.length)
    lines.push(
      '',
      color.yellow('Неизвестный результат операций:'),
      ...status.unknownInvocations.map((item) => item.id),
    );
  note(lines.join('\n'), 'Запуск');
  if (status.result) note(status.result, status.resultTruncated ? 'Часть ответа' : 'Ответ');
  if (status.resultTruncated) prompts.log.info('Полный ответ: harness answer ' + status.runId);
  if (status.error) prompts.log.error(status.error);
}
/** Наблюдение использует курсор событий; повторные запросы не создают новые запуски. */
export async function watch(directory: string, runId: string, json: boolean): Promise<void> {
  const fancy = process.stdout.isTTY && !json;
  const spinner = fancy ? prompts.spinner() : undefined;
  spinner?.start('Агенты приступают к задаче');
  let cursor = 0;
  try {
    while (true) {
      const status = await rpc<StatusView>(directory, 'runtime.status', {
        runId,
        cursor,
        waitMs: 1000,
      });
      cursor = status.cursor;
      if (fancy)
        spinner?.message(
          status.agents
            .map((agent) => agent.role + ': ' + (labels[agent.status] ?? agent.status))
            .join(' · ') +
            '   ' +
            color.dim('шаг ' + status.turns),
        );
      else if (json)
        for (const event of status.events) process.stdout.write(JSON.stringify({ event }) + '\n');
      if (status.status === 'awaiting_approval') {
        spinner?.stop('Нужно решение человека');
        if (fancy) statusCard(status);
        else print(status, true);
        return;
      }
      if (!['running'].includes(status.status)) {
        spinner?.stop(labels[status.status] ?? status.status);
        if (fancy) statusCard(status);
        else print(status, true);
        if (status.status === 'failed') process.exitCode = 1;
        return;
      }
    }
  } catch (error) {
    spinner?.stop('Наблюдение прервано');
    throw error;
  }
}
/** Даёт человеку проверить и однократно разрешить либо отклонить ожидающие операции. */
export async function decideApprovals(directory: string, runId?: string): Promise<void> {
  if (!process.stdin.isTTY) throw new Error('Для подтверждения нужен интерактивный терминал');
  const load = async () =>
    (await rpc<Approval[]>(directory, 'approvals.list')).filter(
      (item) => !runId || item.runId === runId,
    );
  const approvalId = selected(
    await liveSelect({
      title: 'Разрешения',
      load: async () => {
        const approvals = await load();
        return {
          message: 'Выберите ожидающую операцию',
          summary: approvals.length
            ? 'Ожидают решения: ' + approvals.length
            : 'Ожидающих разрешений нет',
          options: [
            ...approvals.map((item) => ({ value: item.id, label: item.tool, hint: item.runId })),
            { value: 'back', label: '← Назад' },
          ],
        };
      },
    }),
  );
  if (approvalId === 'back') return;
  const item = (await load()).find((approval) => approval.id === approvalId);
  if (item) await decideApproval(directory, item);
}

/** Показывает точные аргументы одного вызова; закрытие вопроса не даёт разрешение. */
export async function decideApproval(directory: string, item: Approval): Promise<void> {
  commandPage('Разрешение на действие');
  const explanations: Record<string, string> = {
    'fs.write': 'Модель хочет записать файл. Проверьте путь и содержимое перед подтверждением.',
    'process.exec':
      'Модель хочет запустить программу на вашем компьютере. Она будет работать с правами вашей учётной записи.',
  };
  const explanation =
    explanations[item.tool] ?? 'Модель запрашивает разрешение на операцию ' + item.tool + '.';
  const reason =
    item.reason === 'Policy requires human approval'
      ? 'Правила проекта требуют вашего разрешения.'
      : item.reason;
  const previewToken =
    item.tool === 'fs.write'
      ? await showFilePreview((offset) =>
          rpc<FilePreview>(directory, 'files.preview', { approvalId: item.id, offset }),
        )
      : undefined;
  commandPage('', false);
  const choice = await liveConfirm({
    title: item.tool + ' · разрешение',
    bodyTitle: 'Точные аргументы операции',
    message: 'Разрешить однократное выполнение этой операции?',
    body: explanation + '\n\n' + JSON.stringify(item.args, null, 2) + '\n\n' + reason,
    load: async () => {
      const pending = (await rpc<Approval[]>(directory, 'approvals.list')).some(
        (approval) => approval.id === item.id,
      );
      return {
        available: pending,
        detail: pending ? 'Ожидает вашего решения' : 'Операция уже разрешена или отменена',
      };
    },
  });
  if (choice === undefined) return;
  const allow = selected(choice);
  await rpc(directory, 'approvals.decide', { approvalId: item.id, allow, previewToken });
  prompts.log.success(allow ? 'Операция разрешена один раз' : 'Выполнение отклонено');
}
