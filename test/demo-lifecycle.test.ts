import { expect, test, vi } from 'vitest';
import { access } from 'node:fs/promises';
import type * as channel from '../src/interfaces/ipc.js';
import type * as menu from '../src/interfaces/guided/live-select.js';

vi.mock('../src/interfaces/ipc.js', async (original) => {
  const actual = await original<typeof channel>();
  return { ...actual, serve: vi.fn(actual.serve) };
});
vi.mock('../src/interfaces/guided/live-select.js', async (original) => {
  const actual = await original<typeof menu>();
  return { ...actual, liveSelect: vi.fn(async () => 'exit') };
});
import { serve } from '../src/interfaces/ipc.js';
import { liveSelect } from '../src/interfaces/guided/live-select.js';
import { runDemo } from '../src/interfaces/commands/demo.js';
import { brandName } from '../src/interfaces/branding.js';
import { eventually } from './helpers.js';

/** Проверка отправляет сигнал обработчикам напрямую и не завершает процесс самого Vitest. */
test.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
  'ранний %s закрывает только создаваемый сервис и удаляет его временные файлы',
  async (signal) => {
    const actual = await vi.importActual<typeof channel>('../src/interfaces/ipc.js');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let state: string | undefined;
    vi.mocked(serve).mockImplementationOnce(async (...args) => {
      state = args[1];
      await gate;
      return actual.serve(...args);
    });
    const exits: number[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string) => {
      exits.push(Number(code));
    }) as typeof process.exit);
    const pause = vi.spyOn(process.stdin, 'pause');
    const previous = process.listeners(signal);
    const opening = runDemo();
    try {
      await eventually(() => !!state);
      const added = process.listeners(signal).filter((listener) => !previous.includes(listener));
      expect(added).toHaveLength(1);
      added[0]!(signal);
      release();
      await opening;
      await eventually(() => exits.length === 1);
      expect(exits).toEqual([130]);
      expect(liveSelect).not.toHaveBeenCalled();
      await expect(access(state!)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(pause).toHaveBeenCalled();
      expect(brandName).toBe('Harness by Ghost_Raven');
      expect(process.listeners(signal)).toEqual(previous);
    } finally {
      release();
      await opening;
      exit.mockRestore();
      pause.mockRestore();
    }
  },
  15000,
);
