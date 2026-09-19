import { expect, it } from 'vitest';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnosticExport, writeDiagnosticExport } from '../src/diagnostics/export.js';
import { temporary } from './helpers.js';

it('экспорт содержит только разрешённые версии, счётчики, состояния и коды', () => {
  const privateValue = '/Users/PRIVATE_OWNER/PRIVATE_API_KEY';
  const report = diagnosticExport(
    [
      { name: privateValue, status: 'warn' },
      { name: 'Конфигурация', status: 'pass', detail: privateValue } as {
        name: string;
        status: 'pass';
      },
    ],
    {
      service: {
        version: '0.3.0',
        buildId: 'a'.repeat(64),
        protocolVersion: 1,
        storageVersion: 1,
        configFile: privateValue,
        profiles: [{ model: privateValue }],
        state: privateValue,
      },
      history: {
        checkedAt: new Date().toISOString(),
        healthy: false,
        readOnly: true,
        counts: {
          journals: 1,
          records: 0,
          runs: 0,
          outputs: 0,
          learning: 0,
          unresolvedOperations: 0,
        },
        issues: [
          {
            kind: 'run',
            code: 'JOURNAL_INVALID_RECORD',
            record: 1,
            path: privateValue,
            runId: 'd1272b8c-4c26-4a14-8c17-8d3b22e169c2',
          },
        ],
      } as never,
    },
  );
  const encoded = JSON.stringify(report);
  expect(encoded).not.toMatch(/PRIVATE_|configFile|profiles|state|path|detail/);
  expect(encoded).not.toContain('d1272b8c-4c26-4a14-8c17-8d3b22e169c2');
  expect(report.service).toMatchObject({ version: '0.3.0', buildId: 'a'.repeat(64) });
  expect(report.checks).toEqual([
    { id: 'model-profile', status: 'warn' },
    { id: 'configuration', status: 'pass' },
  ]);
  expect(report.history?.issues).toEqual([
    { kind: 'run', code: 'JOURNAL_INVALID_RECORD', record: 1 },
  ]);
});

it('произвольные строки вместо идентичности сервиса не попадают в экспорт', () => {
  const report = diagnosticExport([], {
    service: {
      version: 'PRIVATE_TASK',
      buildId: '/Users/private',
      protocolVersion: 1,
      storageVersion: 1,
    },
  });
  expect(report.service).toBeUndefined();
});

it('отчёт записывается в новый закрытый файл, существующий файл сохраняется', async () => {
  const directory = await temporary();
  const path = join(directory, 'diagnostic.json');
  const report = diagnosticExport([{ name: 'Node.js', status: 'pass' }]);
  await writeDiagnosticExport(path, report);
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report);
  if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  await writeFile(path, 'USER_FILE');
  await expect(writeDiagnosticExport(path, report)).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path, 'utf8')).toBe('USER_FILE');
});
