import { describe, expect, it } from 'vitest';
import { call, eventually, harness, output, ScriptedProvider } from './helpers.js';
import type { Config } from '../src/configuration/schema.js';
import { configuredControlDefinitions } from '../src/agents/service.js';
import { Semaphore } from '../src/shared/primitives.js';

const roles = (config: Config): void => {
  config.coordination = 'auto';
  config.defaultRole = 'lead';
  config.roles = {
    lead: {
      prompt: 'Собери независимые проверки.',
      permissions: [{ tool: '*', decision: 'allow', args: {} }],
      memory: [],
    },
    catalog: {
      prompt: 'Специалист по каталогу товаров.',
      permissions: [{ tool: 'fs.read', decision: 'allow', args: {} }],
      memory: [],
      modelProfile: 'specialist',
    },
    payments: {
      prompt: 'Специалист по оплате.',
      permissions: [{ tool: 'fs.read', decision: 'allow', args: {} }],
      memory: [],
    },
  };
  config.profiles.specialist = { ...config.profiles.test!, model: 'specialist-model' };
};
const team = () =>
  output('', [
    call('plan', 'agents.plan', {
      mode: 'parallel',
      reason: 'Проверки каталога и оплаты независимы.',
      tasks: [
        { role: 'catalog', task: 'Проверь каталог', context: 'Проверь поля товаров' },
        { role: 'payments', task: 'Проверь оплату', context: 'Проверь статусы платежей' },
      ],
    }),
  ]);

describe('Автоматический выбор ролей из конфигурации', () => {
  it('запускает независимых специалистов одновременно, использует их профиль и собирает результаты', async () => {
    let active = 0,
      peak = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const limiter = new Semaphore(2);
    const scripted = new ScriptedProvider(async (request) => {
      if (request.tools[0]?.name === 'agents.plan') {
        expect(request.messages[0]!.content).toContain('Специалист по каталогу товаров');
        expect(JSON.stringify(request.tools)).toContain('payments');
        return team();
      }
      const system = request.messages[0]!.content;
      if (system.includes('ACTIVE ROLE: catalog') || system.includes('ACTIVE ROLE: payments')) {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        if (system.includes('ACTIVE ROLE: catalog'))
          expect(request.profile.model).toBe('specialist-model');
        return output(
          system.includes('ACTIVE ROLE: catalog') ? 'Каталог проверен' : 'Оплата проверена',
        );
      }
      if (request.messages.some((item) => item.content.includes('incorporate completed child'))) {
        expect(JSON.stringify(request.messages)).toContain('Каталог проверен');
        expect(JSON.stringify(request.messages)).toContain('Оплата проверена');
        return output('Обе проверки завершены');
      }
      return output('Ожидаю проверки');
    });
    const app = await harness(
      { generate: (request) => limiter.use(() => scripted.generate(request), request.signal) },
      roles,
    );
    const { runId } = await app.runtime.start({
      message: 'Проверь каталог и оплату',
      workspace: app.workspace,
      requestKey: 'team',
    });
    await eventually(() => active === 2);
    expect(app.sessions.get(runId).status).toBe('running');
    finish();
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(peak).toBe(2);
    expect(run.status).toBe('completed');
    expect(run.result).toBe('Обе проверки завершены');
    expect(Object.values(run.agents).map((agent) => agent.role)).toEqual([
      'lead',
      'catalog',
      'payments',
    ]);
    expect(run.coordination?.plan?.mode).toBe('parallel');
  });

  it('после передачи специализации сохраняет потолок прав исходной роли', async () => {
    const app = await harness(
      new ScriptedProvider((request) => {
        if (request.tools[0]?.name === 'agents.plan')
          return output('', [
            call('plan', 'agents.plan', {
              mode: 'handoff',
              reason: 'Нужна специализация каталога',
              tasks: [{ role: 'catalog', task: 'Проверка', context: '' }],
            }),
          ]);
        expect(request.messages[0]!.content).toContain('ACTIVE ROLE: catalog');
        if (request.messages.some((item) => item.toolCallId === 'write'))
          return output('Запрет учтён');
        return output('', [call('write', 'fs.write', { path: 'blocked', content: 'x' })]);
      }),
      roles,
    );
    const { runId } = await app.runtime.start({
      message: 'Проверь каталог',
      workspace: app.workspace,
      requestKey: 'handoff-plan',
    });
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.agents[run.rootAgentId]!.authorityRoles).toEqual(['lead', 'catalog']);
    expect(Object.values(run.invocations).find((item) => item.call.id === 'write')?.status).toBe(
      'denied',
    );
    expect(run.handoffs).toBe(1);
  });

  it('не подставляет имена ролей из шаблона и ограничивает исправление неверного плана', async () => {
    const provider = new ScriptedProvider(() =>
      output('', [
        call('bad-' + Math.random(), 'agents.plan', {
          mode: 'parallel',
          reason: 'Проверка',
          tasks: [{ role: 'researcher', task: 'Работа', context: '' }],
        }),
      ]),
    );
    const app = await harness(provider, roles);
    const { runId } = await app.runtime.start({
      message: 'Задача',
      workspace: app.workspace,
      requestKey: 'invalid',
    });
    await app.runtime.wait(runId);
    expect(provider.requests).toHaveLength(2);
    expect(app.sessions.get(runId).status).toBe('failed');
    expect(Object.values(app.sessions.get(runId).agents)).toHaveLength(1);
    const definitions = configuredControlDefinitions(app.snapshot.value);
    expect((definitions[0]!.schema.properties as Record<string, unknown>).role).toEqual({
      type: 'string',
      enum: ['lead', 'catalog', 'payments'],
    });
  });

  it('не исполняет обычный вызов инструмента вместо плана', async () => {
    let count = 0;
    const app = await harness(
      new ScriptedProvider(() =>
        output('', [call('write' + count++, 'fs.write', { path: 'never', content: 'x' })]),
      ),
      roles,
    );
    const { runId } = await app.runtime.start({
      message: 'Запиши файл',
      workspace: app.workspace,
      requestKey: 'not-plan',
    });
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).invocations).toEqual({});
    expect(app.sessions.get(runId).status).toBe('failed');
  });

  it('план не обходит ask: до одобрения дочерняя роль не запущена', async () => {
    const app = await harness(
      new ScriptedProvider((request) => {
        if (request.tools[0]?.name === 'agents.plan')
          return output('', [
            call('plan', 'agents.plan', {
              mode: 'parallel',
              reason: 'Проверка каталога',
              tasks: [{ role: 'catalog', task: 'Проверка', context: '' }],
            }),
          ]);
        return output('Готово');
      }),
      (config) => {
        roles(config);
        config.policy.rules.push({ tool: 'agents.delegate', decision: 'ask', args: {} });
      },
    );
    const { runId } = await app.runtime.start({
      message: 'Задача',
      workspace: app.workspace,
      requestKey: 'ask-plan',
    });
    await eventually(() => app.approvals.pending().length === 1);
    expect(Object.values(app.sessions.get(runId).agents)).toHaveLength(1);
    await app.approvals.resolve(app.approvals.pending()[0]!.id, true);
    await app.runtime.wait(runId);
    expect(Object.values(app.sessions.get(runId).agents)).toHaveLength(2);
  });

  it('после паузы продолжает сохранённый план без повторного создания специалистов', async () => {
    const provider = new ScriptedProvider((request) =>
      request.tools[0]?.name === 'agents.plan' ? team() : output('Проверено'),
    );
    const app = await harness(provider, (config) => {
      roles(config);
      config.limits.turns = 1;
    });
    const { runId } = await app.runtime.start({
      message: 'Две проверки',
      workspace: app.workspace,
      requestKey: 'paused-plan',
    });
    await app.runtime.wait(runId);
    expect(app.sessions.get(runId).status).toBe('paused');
    const children = app.sessions.get(runId).agents[app.sessions.get(runId).rootAgentId]!.children;
    await app.runtime.setIterationLimit(20, runId);
    await app.runtime.resume(runId);
    await app.runtime.wait(runId);
    const run = app.sessions.get(runId);
    expect(run.status).toBe('completed');
    expect(run.agents[run.rootAgentId]!.children).toHaveLength(2);
    expect(run.agents[run.rootAgentId]!.children).toEqual(expect.arrayContaining(children));
    expect(
      provider.requests.filter((request) => request.tools[0]?.name === 'agents.plan'),
    ).toHaveLength(1);
  });
});
