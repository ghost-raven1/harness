import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { harness, ScriptedProvider, output, call } from './helpers.js';

describe('Роли и дерево агентов', () => {
  it('делегирует, собирает результаты и не расширяет права при handoff', async () => {
    const provider = new ScriptedProvider((request) => {
      const first = request.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('\n');
      if (first.includes('дочерняя работа')) {
        if (request.messages.some((m) => m.role === 'tool')) return output('Запрет сохранён');
        return output('', [call('forbidden', 'fs.write', { path: 'forbidden', content: 'x' })]);
      }
      if (request.messages.some((m) => m.content.includes('incorporate completed child')))
        return output('Подзадача проверена');
      if (request.messages.some((m) => m.role === 'tool')) return output('Предварительный итог');
      return output('', [
        call('delegate', 'agents.delegate', { role: 'reader', task: 'дочерняя работа' }),
      ]);
    });
    const app = await harness(provider);
    const { runId } = await app.runtime.start({
      message: 'Главная работа',
      workspace: app.workspace,
      requestKey: 'agents',
    });
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.status).toBe('completed');
    expect(Object.values(run.agents)).toHaveLength(2);
    expect(Object.values(run.invocations).find((i) => i.call.id === 'forbidden')?.status).toBe(
      'denied',
    );
    expect(run.result).toBe('Подзадача проверена');
  });

  it('handoff сохраняет исходный потолок прав и отвергает смешанный пакет', async () => {
    const provider = new ScriptedProvider((_, index) =>
      index === 0
        ? output('', [call('h', 'agents.handoff', { role: 'worker', reason: 'нужна другая роль' })])
        : index === 1
          ? output('', [call('w', 'fs.write', { path: 'x', content: 'x' })])
          : output('Ограничения соблюдены'),
    );
    const app = await harness(provider, (config) => {
      config.defaultRole = 'reader';
    });
    const { runId } = await app.runtime.start({
      message: 'x',
      workspace: app.workspace,
      requestKey: 'handoff',
    });
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.agents[run.rootAgentId]!.role).toBe('worker');
    expect(Object.values(run.invocations).find((i) => i.call.name === 'fs.write')?.status).toBe(
      'denied',
    );
  });

  it('при ошибке дочерней роли останавливает её потомков до итогового ответа корня', async () => {
    let grandchildStopped = false;
    const provider = new ScriptedProvider(async (request) => {
      const system = request.messages[0]!.content;
      if (system.includes('ACTIVE ROLE: reader')) {
        await new Promise<void>((resolve) => {
          const stop = () => {
            grandchildStopped = true;
            resolve();
          };
          if (request.signal?.aborted) stop();
          else request.signal?.addEventListener('abort', stop, { once: true });
        });
        throw new Error('Cancelled grandchild');
      }
      if (system.includes('ACTIVE ROLE: worker')) {
        if (request.messages.some((m) => m.role === 'tool')) throw new Error('Child model failure');
        return output('', [
          call('grandchild', 'agents.delegate', { role: 'reader', task: 'Долгое чтение' }),
        ]);
      }
      if (request.messages.some((m) => m.content.includes('incorporate completed child'))) {
        expect(grandchildStopped).toBe(true);
        return output('Ошибка ветки учтена');
      }
      if (request.messages.some((m) => m.role === 'tool')) return output('Промежуточный итог');
      return output('', [call('child', 'agents.delegate', { role: 'worker', task: 'Подзадача' })]);
    });
    const app = await harness(provider);
    const { runId } = await app.runtime.start({
      message: 'x',
      workspace: app.workspace,
      requestKey: 'child-failure',
    });
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).status).toBe('completed');
    expect(Object.values(app.sessions.get(runId).agents).map((a) => a.status)).toEqual([
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('смешанный handoff-пакет не выполняет ни передачу, ни мутацию', async () => {
    const app = await harness(
      new ScriptedProvider((_, index) =>
        index
          ? output('Исправляю пакет')
          : output('', [
              call('handoff', 'agents.handoff', { role: 'worker', reason: 'Передача' }),
              call('write', 'fs.write', { path: 'x', content: 'x' }),
            ]),
      ),
    );
    const { runId } = await app.runtime.start({
      message: 'x',
      workspace: app.workspace,
      requestKey: 'mixed',
    });
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.handoffs).toBe(0);
    expect(Object.values(run.invocations).every((i) => i.status === 'error')).toBe(true);
    await expect(readFile(join(app.workspace, 'x'))).rejects.toThrow();
  });

  it.each(['agents', 'depth', 'handoffs'] as const)(
    'не превышает настроенный лимит %s',
    async (limit) => {
      const app = await harness(
        new ScriptedProvider((_, index) =>
          index
            ? output('Лимит принят')
            : output('', [
                limit === 'handoffs'
                  ? call('h', 'agents.handoff', { role: 'worker', reason: 'Передача' })
                  : call('d', 'agents.delegate', { role: 'worker', task: 'Подзадача' }),
              ]),
        ),
        (config) => {
          config.limits[limit] = limit === 'agents' ? 1 : 0;
        },
      );
      const { runId } = await app.runtime.start({
        message: 'x',
        workspace: app.workspace,
        requestKey: limit,
      });
      await app.runtime.wait(runId);
      const run = app.sessions.get(runId);
      expect(Object.values(run.agents)).toHaveLength(1);
      expect(run.handoffs).toBe(0);
      expect(Object.values(run.invocations)[0]?.status).toBe('error');
    },
  );
});
