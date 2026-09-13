import * as prompts from '@clack/prompts';
import { emitKeypressEvents, type Key } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { CliContext, StatusView, TaskView } from '../types.js';
import { decideApproval, labels, note } from '../ui.js';
import { explainError } from './errors.js';
import { page } from './screen.js';
import { TaskScreen, type ViewKey } from './task-screen.js';
import { isMissingResource } from '../../shared/resource-errors.js';
import { readText } from './text-reader.js';

/** Клавиши принадлежат экрану только между вопросами Clack; исходный режим восстанавливается. */
export function watchKeys(onKey: (action: ViewKey) => void): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  const raw = process.stdin.isRaw,
    wasFlowing = process.stdin.readableFlowing === true;
  emitKeypressEvents(process.stdin);
  const handler = (_text: string, key: Key): void => {
    if (key.ctrl && key.name === 'c') onKey('cancel');
    const names: Record<string, ViewKey> = {
      escape: 'back',
      return: 'enter',
      tab: 'tab',
      up: 'up',
      down: 'down',
      pageup: 'page-up',
      pagedown: 'page-down',
      end: 'end',
    };
    if (key.name && names[key.name]) onKey(names[key.name]!);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handler);
  return () => {
    process.stdin.off('keypress', handler);
    process.stdin.setRawMode(raw);
    if (!wasFlowing) process.stdin.pause();
  };
}

export function simpleResult(status: StatusView): void {
  if (status.result)
    note(
      status.result,
      status.resultTruncated ? 'Часть ответа · полный текст в «Прочитать ответ»' : 'Ответ',
    );
  else prompts.log.info(labels[status.status] ?? status.status);
  if (status.error) prompts.log.error(explainError(status.error));
  if (status.status === 'paused')
    note(
      'Задача сохранена. Откройте её в «Моих задачах», чтобы проверить прерванные операции и продолжить.',
      'Работа приостановлена',
    );
}

/** Живой просмотр дочитывает все страницы, а разрешения показывает после освобождения клавиатуры. */
export async function followRun(
  context: CliContext,
  runId: string,
  options: { inspect?: boolean } = {},
): Promise<StatusView | undefined> {
  let cursor = 0,
    outputCursor = 0;
  page('', false);
  let screen = new TaskScreen();
  try {
    while (true) {
      let action: ViewKey | undefined;
      const stopKeys = watchKeys((value) => {
        if (['back', 'cancel', 'enter'].includes(value)) action = value;
        else screen.key(value);
      });
      let status: TaskView;
      try {
        while (true) {
          try {
            status = await context.request<TaskView>('runtime.task', {
              runId,
              cursor,
              outputCursor,
            });
            screen.connectionLost = false;
          } catch (error) {
            if (isMissingResource(error, 'task')) throw error;
            if (!context.interactive()) throw error;
            screen.connectionLost = true;
            screen.render();
            if (action === 'back' || action === 'enter') return undefined;
            await delay(500);
            continue;
          }
          cursor = status.cursor;
          outputCursor = status.output.cursor;
          screen.feed.update(status);
          screen.render();
          const backlog = status.hasMoreEvents || status.output.hasMore;
          const active =
            !status.deletedAt && ['running', 'awaiting_approval'].includes(status.status);
          if (
            action ||
            (!backlog &&
              ((!status.deletedAt && status.approvals.length) || (!active && !options.inspect)))
          )
            break;
          if (!backlog) await delay(200);
        }
      } finally {
        stopKeys();
      }
      if (action === 'back') return undefined;
      if (action === 'cancel' && !status.deletedAt) {
        await context.request('runtime.cancel', { runId });
        status = await context.request<TaskView>('runtime.task', { runId, cursor, outputCursor });
        screen.feed.update(status);
        screen.render();
      }
      screen.close();
      if (
        !status.deletedAt &&
        status.approvals.length &&
        action !== 'cancel' &&
        action !== 'enter'
      ) {
        page('Разрешение на действие');
        try {
          for (const approval of status.approvals)
            await decideApproval(context.directory(), approval);
        } catch (error) {
          if (error instanceof Error && error.message === 'INTERACTIVE_CANCEL') {
            prompts.log.info('Задача ждёт вашего решения в «Моих задачах».');
            return undefined;
          }
          throw error;
        }
        page('', false);
        const feed = screen.feed;
        screen = new TaskScreen(feed);
        continue;
      }
      if (action !== 'enter') simpleResult(status);
      return status;
    }
  } catch (error) {
    if (!isMissingResource(error, 'task')) throw error;
    screen.close();
    await readText('Задача удалена', [
      {
        id: 'removed',
        label: 'Задача',
        text: 'Задача удалена в другом окне. Esc — к списку задач.',
      },
    ]);
    return undefined;
  } finally {
    screen.close();
  }
}
