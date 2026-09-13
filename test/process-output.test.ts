import { expect, it } from 'vitest';
import { executeProgram } from '../src/tools/process.js';
import { temporary } from './helpers.js';

const limit = 1048576;

it('вывод ровно на границе каждого потока сохраняется без ложной отметки обрезания', async () => {
  const result = await executeProgram(
    process.execPath,
    [
      '-e',
      `process.stdout.write('x'.repeat(${limit})); process.stderr.write('y'.repeat(${limit}));`,
    ],
    { workspace: await temporary(), signal: new AbortController().signal },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toHaveLength(limit);
  expect(result.stderr).toHaveLength(limit);
  expect(result.stdoutTruncated).toBe(false);
  expect(result.stderrTruncated).toBe(false);
});

it('потерянный хвост обоих потоков явно отмечается даже при успешном коде выхода', async () => {
  const result = await executeProgram(
    process.execPath,
    [
      '-e',
      `process.stdout.write('x'.repeat(${limit})+'STDOUT_END'); process.stderr.write('y'.repeat(${limit})+'STDERR_END');`,
    ],
    { workspace: await temporary(), signal: new AbortController().signal },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toHaveLength(limit);
  expect(result.stderr).toHaveLength(limit);
  expect(result.stdout).not.toContain('STDOUT_END');
  expect(result.stderr).not.toContain('STDERR_END');
  expect(result.stdoutTruncated).toBe(true);
  expect(result.stderrTruncated).toBe(true);
});

it.each(['stdout', 'stderr'] as const)(
  'флаг %s не объявляет второй поток обрезанным',
  async (stream) => {
    const other = stream === 'stdout' ? 'stderr' : 'stdout';
    const result = await executeProgram(
      process.execPath,
      [
        '-e',
        `process.${stream}.write('x'.repeat(${limit + 1})); process.${other}.write('Короткий вывод');`,
      ],
      { workspace: await temporary(), signal: new AbortController().signal },
    );
    expect(result[(stream + 'Truncated') as 'stdoutTruncated' | 'stderrTruncated']).toBe(true);
    expect(result[(other + 'Truncated') as 'stdoutTruncated' | 'stderrTruncated']).toBe(false);
    expect(result[other]).toBe('Короткий вывод');
  },
);
