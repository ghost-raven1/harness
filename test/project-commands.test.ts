import { expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectInputs } from '../src/projects/schema.js';
import {
  commands,
  parseCommandInput,
  parseCommandResponse,
} from '../src/interfaces/contracts/index.js';
import { registerProjectCommands } from '../src/interfaces/commands/projects.js';
import { projectsCommand } from '../src/application/commands/projects.js';
import type { Application } from '../src/application/bootstrap.js';
import type { CliContext } from '../src/interfaces/types.js';
import { projectFixture } from './project-ui-fixture.js';
import { temporary } from './helpers.js';

it('каждая локальная операция проекта использует доменную схему и проверяет вложенный ответ', () => {
  for (const [name, schema] of Object.entries(projectInputs))
    expect(commands[('projects.' + name) as keyof typeof commands].params).toBe(schema);
  expect(parseCommandInput('projects.list', {})).toEqual({
    query: '',
    page: 0,
    limit: 10,
    includeArchived: false,
  });
  expect(() => parseCommandInput('projects.pause', { projectId: 'x', requestKey: 'x' })).toThrow();
  expect(() =>
    parseCommandInput('projects.acceptPlan', {
      projectId: 'x',
      requestKey: 'x',
      expectedRevision: 1,
      expectedPlanVersion: 0,
    }),
  ).toThrow();
  expect(
    parseCommandResponse('projects.detail', projectFixture()).plan?.stages[0]?.verification.kind,
  ).toBe('commands');
  expect(() =>
    parseCommandResponse('projects.detail', {
      ...projectFixture(),
      stages: [{ stageId: 'broken' }],
    }),
  ).toThrow();
});

it('прикладной обработчик валидирует ревизию до вызова сервиса', async () => {
  const acceptPlan = vi.fn().mockResolvedValue(projectFixture());
  const app = { projects: { acceptPlan } } as unknown as Application;
  await expect(
    projectsCommand(app, 'projects.acceptPlan', { projectId: 'p', requestKey: 'k' }),
  ).rejects.toThrow();
  expect(acceptPlan).not.toHaveBeenCalled();
  const input = { projectId: 'p', requestKey: 'k', expectedRevision: 5, expectedPlanVersion: 2 };
  await projectsCommand(app, 'projects.acceptPlan', input);
  expect(acceptPlan).toHaveBeenCalledExactlyOnceWith(input);
});

it('режим диагностики убирает действия и отклоняет мутации до обращения к сервису', async () => {
  const view = projectFixture();
  const pause = vi.fn();
  const app = {
    sessions: {},
    projects: { store: { recoveryError: 'Повреждён журнал' }, detail: async () => view, pause },
  } as unknown as Application;
  expect(
    await projectsCommand(app, 'projects.detail', { projectId: view.projectId }),
  ).toMatchObject({ allowedActions: [], reason: 'Повреждён журнал' });
  expect(view.allowedActions).toContain('acceptPlan');
  await expect(
    projectsCommand(app, 'projects.pause', {
      projectId: view.projectId,
      expectedRevision: view.revision,
      requestKey: 'pause',
    }),
  ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  expect(pause).not.toHaveBeenCalled();
});

/** Запускает настоящий Commander без сервиса и сохраняет запросы к типизированному порту. */
function commandFixture() {
  const request = vi.fn().mockResolvedValue(projectFixture());
  const output = vi.fn();
  const context = {
    request,
    output,
    directory: () => '/state',
    interactive: () => false,
    json: () => true,
  } as unknown as CliContext;
  return {
    request,
    output,
    run: async (...args: string[]) => {
      const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
      registerProjectCommands(program, context);
      await program.parseAsync(['node', 'harness', 'projects', ...args]);
    },
  };
}

it('CLI требует ревизию и ключ, сохраняет реквизиты повторной отправки', async () => {
  const cli = commandFixture();
  await expect(cli.run('pause', 'p', '--key', 'same')).rejects.toThrow();
  await expect(cli.run('pause', 'p', '--revision', '-1', '--key', 'same')).rejects.toThrow();
  expect(cli.request).not.toHaveBeenCalled();
  await cli.run('pause', 'p', '--revision', '7', '--key', 'same');
  await cli.run('pause', 'p', '--revision', '7', '--key', 'same');
  expect(cli.request.mock.calls).toEqual(
    Array(2).fill(['projects.pause', { projectId: 'p', expectedRevision: 7, requestKey: 'same' }]),
  );
});

it('CLI сохраняет отдельные версии плана и результата, не подставляя текущие автоматически', async () => {
  const cli = commandFixture();
  await cli.run('accept-plan', 'p', '--revision', '8', '--key', 'plan', '--plan-version', '3');
  expect(cli.request).toHaveBeenLastCalledWith('projects.acceptPlan', {
    projectId: 'p',
    expectedRevision: 8,
    requestKey: 'plan',
    expectedPlanVersion: 3,
  });
  await cli.run(
    'manual-check',
    'p',
    'stage',
    '--revision',
    '9',
    '--key',
    'manual',
    '--result-revision',
    'digest',
    '--outcome',
    'passed',
    '--comment',
    'Проверено',
  );
  expect(cli.request).toHaveBeenLastCalledWith('projects.manualCheck', {
    projectId: 'p',
    expectedRevision: 9,
    requestKey: 'manual',
    stageId: 'stage',
    expectedResultRevision: 'digest',
    outcome: 'passed',
    comment: 'Проверено',
  });
});

it('CLI edit проверяет файл и не передаёт лишние поля политики', async () => {
  const cli = commandFixture();
  const path = join(await temporary(), 'plan.json');
  const { version: _version, ...plan } = projectFixture().plan!;
  await writeFile(path, JSON.stringify({ ...plan, allowAll: true }));
  await expect(
    cli.run('edit', 'p', '--revision', '1', '--key', 'edit', '--file', path),
  ).rejects.toThrow();
  expect(cli.request).not.toHaveBeenCalled();
  await writeFile(path, JSON.stringify(plan));
  await cli.run('edit', 'p', '--revision', '1', '--key', 'edit', '--file', path);
  expect(cli.request).toHaveBeenCalledWith('projects.editPlan', {
    projectId: 'p',
    expectedRevision: 1,
    requestKey: 'edit',
    plan,
  });
});

it('удаление требует просмотренный токен, resolve — явный исход', async () => {
  const cli = commandFixture();
  await expect(cli.run('purge', 'p', '--revision', '1', '--key', 'delete')).rejects.toThrow();
  await expect(
    cli.run(
      'resolve',
      'p',
      'run',
      'call',
      '--revision',
      '1',
      '--key',
      'resolve',
      '--result',
      'Файл создан',
      '--outcome',
      'maybe',
    ),
  ).rejects.toThrow();
  expect(cli.request).not.toHaveBeenCalled();
  await cli.run('purge', 'p', '--revision', '1', '--key', 'delete', '--preview-token', 'preview');
  expect(cli.request).toHaveBeenLastCalledWith('projects.purge', {
    projectId: 'p',
    expectedRevision: 1,
    requestKey: 'delete',
    previewToken: 'preview',
  });
});
