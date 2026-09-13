import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerRunCommands } from '../src/interfaces/commands/run.js';
import type { CliContext } from '../src/interfaces/types.js';
import { eventually, temporary } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

it.each(['decline', 'confirm', 'cancel'] as const)(
  '%s передаёт только явно подтверждённый результат после настоящего вопроса Clack',
  async (answer) => {
    const root = await temporary(),
      file = join(root, 'Результат.txt');
    await writeFile(file, 'Операция не выполнилась.');
    const request = vi.fn(async () => ({ resolved: true }));
    const context = {
      request,
      directory: () => root,
      interactive: () => true,
      json: () => false,
      output: vi.fn(),
    } as CliContext;
    const program = new Command();
    registerRunCommands(program, context);
    const properties: Array<[object, string, PropertyDescriptor | undefined]> = [];
    const replace = (target: object, key: string, value: unknown): void => {
      properties.push([target, key, Object.getOwnPropertyDescriptor(target, key)]);
      Object.defineProperty(target, key, { configurable: true, value });
    };
    const wasFlowing = process.stdin.readableFlowing === true;
    process.stdin.pause();
    replace(process.stdin, 'isTTY', true);
    replace(process.stdin, 'isRaw', false);
    replace(process.stdin, 'setRawMode', vi.fn());
    const initialKeys = process.stdin.listenerCount('keypress');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const completed = program
        .parseAsync([
          'node',
          'harness',
          'resolve',
          'run',
          'call',
          '--result-file',
          file,
          '--failed',
        ])
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await eventually(() => process.stdin.listenerCount('keypress') > initialKeys);
      if (answer === 'cancel')
        process.stdin.emit('keypress', '\x03', { name: 'c', ctrl: true, sequence: '\x03' });
      else {
        if (answer === 'confirm') process.stdin.emit('keypress', 'y', { name: 'y' });
        process.stdin.emit('keypress', '\r', { name: 'return' });
      }
      const result = await completed;
      if (answer === 'cancel') expect(result).toMatchObject({ message: 'INTERACTIVE_CANCEL' });
      else expect(result).toBeUndefined();
      if (answer === 'confirm')
        expect(request).toHaveBeenCalledExactlyOnceWith('runtime.resolve', {
          runId: 'run',
          invocationId: 'call',
          result: 'Операция не выполнилась.',
          succeeded: false,
        });
      else expect(request).not.toHaveBeenCalled();
    } finally {
      for (const [target, key, descriptor] of properties.reverse()) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
      if (wasFlowing) process.stdin.resume();
    }
  },
);
