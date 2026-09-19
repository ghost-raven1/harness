import { beforeEach, expect, it, vi } from 'vitest';
import * as files from 'node:fs/promises';
import { join } from 'node:path';
import { harness, output, ScriptedProvider } from './helpers.js';
import type { HistoryVerificationReport } from '../src/diagnostics/history-types.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof files>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof files>('node:fs/promises');

beforeEach(() => {
  vi.mocked(files.open).mockReset().mockImplementation(actual.open);
});

it.each(['output', 'learning'] as const)(
  'online проверка ожидает завершения записи %s и не объявляет промежуточный хвост повреждением',
  async (kind) => {
    const app = await harness(new ScriptedProvider(() => output('Проверено')));
    const { runId } = await app.runtime.start({
      message: 'Задача проверки',
      workspace: app.workspace,
      requestKey: 'verification-barrier',
    });
    await app.runtime.wait(runId);
    const run = await app.sessions.load(runId);
    const path =
      kind === 'output'
        ? join(app.sessions.directory, 'output', runId + '.jsonl')
        : join(app.sessions.directory, 'learning.jsonl');
    let partiallyWritten!: () => void;
    const partial = new Promise<void>((resolve) => {
      partiallyWritten = resolve;
    });
    let finishWriting!: () => void;
    const resume = new Promise<void>((resolve) => {
      finishWriting = resolve;
    });
    let intercepted = false;
    vi.mocked(files.open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      if (!intercepted && args[0] === path && args[1] === 'a') {
        intercepted = true;
        vi.spyOn(file, 'writeFile').mockImplementationOnce(async (data) => {
          const bytes = Buffer.from(String(data));
          const middle = Math.floor(bytes.length / 2);
          await file.write(bytes.subarray(0, middle));
          partiallyWritten();
          await resume;
          await file.write(bytes.subarray(middle));
        });
      }
      return file;
    });
    const writing =
      kind === 'output'
        ? app.sessions.output.append(runId, [
            {
              at: new Date().toISOString(),
              requestId: 'continued-output',
              agentId: run.rootAgentId,
              role: 'coordinator',
              type: 'text',
              text: 'Проверка во время записи',
            },
          ])
        : app.learning.update((state) => {
            state.paused = true;
          });
    let verification: Promise<HistoryVerificationReport> | undefined;
    try {
      await partial;
      let finished = false;
      verification = app.sessions.verifyHistory((work) => app.learning.withReadBarrier(work));
      void verification.then(() => {
        finished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      finishWriting();
      await writing;
      const report = await verification;
      expect(report).toMatchObject({ healthy: true, readOnly: false, issues: [] });
      expect(app.sessions.recoveryError).toBeUndefined();
    } finally {
      finishWriting();
      await Promise.allSettled([writing, ...(verification ? [verification] : [])]);
    }
  },
);
