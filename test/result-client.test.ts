import { expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { completeResult } from '../src/interfaces/result-client.js';
import { registerRunCommands } from '../src/interfaces/commands/run.js';
import { ReaderState } from '../src/interfaces/guided/text-reader.js';
import type { StatusView, CliContext } from '../src/interfaces/types.js';

const status = {
  runId: 'fixed-run',
  result: 'А',
  resultTruncated: true,
  resultLength: 3,
} as StatusView;

it('CLI answer дочитывает выбранный запуск и выводит полный ответ', async () => {
  const output = vi.fn();
  const request = vi.fn(async (method, input) => {
    expect(input.runId).toBe(status.runId);
    if (method === 'runtime.status') return status;
    expect(method).toBe('runtime.result');
    return input.cursor === 0
      ? { text: 'А', cursor: 0, nextCursor: 1, total: 3, hasMore: true }
      : { text: '🙂', cursor: 1, nextCursor: 3, total: 3, hasMore: false };
  });
  const context = { request, output, json: () => true } as unknown as CliContext;
  const program = new Command();
  registerRunCommands(program, context);
  await program.parseAsync(['node', 'harness', 'answer', status.runId]);
  expect(output).toHaveBeenCalledExactlyOnceWith({ runId: status.runId, result: 'А🙂' });
});

it.each([
  { text: 'А', cursor: 0, nextCursor: 1, total: 4, hasMore: true },
  { text: '', cursor: 0, nextCursor: 0, total: 3, hasMore: true },
  { text: 'А', cursor: 0, nextCursor: 1, total: 3, hasMore: false },
])('не возвращает неполный ответ при нарушении границ страницы: %j', async (page) => {
  const request = vi.fn().mockResolvedValue(page);
  await expect(completeResult({ request }, status)).rejects.toThrow();
});

it('действие чтения частями появляется после живого обновления экрана', () => {
  const state = new ReaderState({ tabs: [{ id: 'answer', label: 'Ответ', text: 'Ожидание' }] });
  expect(state.actionLabel).toBeUndefined();
  state.update({
    tabs: [{ id: 'answer', label: 'Ответ', text: 'Первая часть' }],
    actionLabel: 'читать по частям',
  });
  expect(state.actionLabel).toBe('читать по частям');
  expect(state.frame('Ответ', 80, 24)).toContain('Enter — читать по частям');
});
