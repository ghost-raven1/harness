import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, ScriptedProvider, output, call } from './helpers.js';
import { projectInput } from './project-runtime-helpers.js';
import { hash } from '../src/shared/primitives.js';

describe('Внутренний runtime проектов', () => {
  it('планировщик читает файлы, но не получает и не исполняет скрытые мутации или делегирование', async () => {
    const provider = new ScriptedProvider((request, index) => {
      expect(request.tools.map((tool) => tool.name).sort()).toEqual([
        'artifacts.read',
        'fs.list',
        'fs.read',
        'fs.search',
      ]);
      return index
        ? output('{"stages":[]}')
        : output('', [
            call('read', 'fs.read', { path: 'data' }),
            call('write', 'fs.write', { path: 'data', content: 'замена' }),
            call('delegate', 'agents.delegate', { role: 'worker', task: 'Запиши файл' }),
          ]);
    });
    const app = await harness(provider, (config) => {
      config.coordination = 'auto';
    });
    await writeFile(join(app.workspace, 'data'), 'исходник');
    const port = app.runtime.projectRuns();
    const input = projectInput(app, 'planning');
    const ref = await port.start(input);
    await app.runtime.wait(ref.runId);
    const run = await port.inspect(ref.runId);
    expect(run.result).toBe('{"stages":[]}');
    expect(run.coordination).toBeUndefined();
    expect(Object.keys(run.agents)).toHaveLength(1);
    expect(Object.values(run.invocations).map((item) => item.status)).toEqual([
      'succeeded',
      'denied',
      'denied',
    ]);
    expect(await readFile(join(app.workspace, 'data'), 'utf8')).toBe('исходник');
    expect(await port.start(input)).toEqual(ref);
    expect(provider.requests).toHaveLength(2);
  });

  it('сохраняет закреплённые роль, права, конфигурацию, опыт и лимит независимо от новых настроек', async () => {
    const app = await harness(new ScriptedProvider(() => output('Готово')));
    const input = projectInput(app);
    input.config.value.roles.coordinator!.permissions = [
      { tool: 'fs.read', decision: 'allow', args: {} },
    ];
    input.config.hash = hash(input.config.value);
    await app.runtime.setIterationLimit(999);
    await app.learning.update((state) => {
      state.releases.new = { id: 'new', createdAt: new Date().toISOString(), candidateIds: [] };
      state.activeVersion = 'new';
    });
    const { runId } = await app.runtime.projectRuns().start(input);
    await app.runtime.wait(runId);
    const run = await app.sessions.load(runId);
    expect(run.config).toEqual(input.config);
    expect(run.learningVersion).toBe('baseline');
    expect(run.iterationLimit).toBe(input.config.value.limits.turns);
    expect(run.agents[run.rootAgentId]!.authorityRoles).toEqual(['coordinator', 'worker']);
    expect(app.policy.decide(run.config.value, run.agents[run.rootAgentId]!, 'fs.write', {})).toBe(
      'deny',
    );
  });

  it('проверки вызывают executor последовательно, сохраняют exitCode при обрезке и не обращаются к модели', async () => {
    const provider = new ScriptedProvider(() => {
      throw new Error('LLM не нужен');
    });
    const app = await harness(provider, (config) => {
      config.policy.rules = [{ tool: '*', decision: 'allow', args: {} }];
      config.tools.resultBytes = 256;
    });
    const input = projectInput(app, 'checks');
    input.calls = [
      call('first', 'process.exec', {
        command: process.execPath,
        args: ['-e', 'console.log("a".repeat(2000))'],
      }),
      call('fails', 'process.exec', { command: process.execPath, args: ['-e', 'process.exit(7)'] }),
      call('never', 'process.exec', {
        command: process.execPath,
        args: ['-e', 'throw Error("must not run")'],
      }),
    ];
    const { runId } = await app.runtime.projectRuns().start(input);
    await app.runtime.wait(runId);
    const run = await app.sessions.load(runId);
    expect(run.status).toBe('failed');
    expect(run.turns).toBe(0);
    expect(provider.requests).toHaveLength(0);
    const checks = Object.values(run.invocations);
    expect(checks.map((item) => item.call.id)).toEqual(['first', 'fails']);
    expect(checks.map((item) => item.exitCode)).toEqual([0, 7]);
    expect(JSON.parse(checks[0]!.result!).truncated).toBe(true);
    expect(run.agents[run.rootAgentId]!.role).toBe('coordinator');
  });

  it('копирует полные результаты зависимостей только своего проекта в собственные артефакты', async () => {
    const answer = 'Полный ответ '.repeat(5000);
    const app = await harness(new ScriptedProvider(() => output(answer)));
    const port = app.runtime.projectRuns();
    const first = await port.start(projectInput(app));
    await app.runtime.wait(first.runId);
    const input = {
      ...projectInput(app),
      requestKey: 'second',
      dependencies: [{ runId: first.runId, title: 'Первый этап' }],
    };
    const second = await port.start(input);
    await app.runtime.wait(second.runId);
    const run = await port.inspect(second.runId);
    const dependency = run.projectDependencies![0]!;
    expect(dependency.artifactId).toBeTruthy();
    expect(run.agents[run.rootAgentId]!.task).toContain(dependency.artifactId);
    expect(run.agents[run.rootAgentId]!.task).not.toContain(answer);
    const artifact = await app.sessions.readArtifact(
      second.runId,
      dependency.artifactId!,
      0,
      answer.length,
    );
    expect(artifact).toBe(answer);
    expect(await port.start(input)).toEqual(second);
    expect((await port.inspect(second.runId)).artifacts).toHaveLength(1);
    await expect(
      port.start({ ...input, requestKey: 'foreign', link: { ...input.link, projectId: 'other' } }),
    ).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
  });
});
