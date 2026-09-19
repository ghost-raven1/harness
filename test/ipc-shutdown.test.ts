import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { join } from 'node:path';
import { rpc, serve } from '../src/interfaces/ipc.js';
import { cleanup, configDirectory, eventually, temporary } from './helpers.js';

it('закрытие удерживает каталог до завершения принятой записи, включая повторный close', async () => {
  const root = await temporary();
  const directory = join(root, 'state');
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const service = await serve(config, directory);
  cleanup(() => service.close());
  let entered = false;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const create = service.app.drafts.create.bind(service.app.drafts);
  vi.spyOn(service.app.drafts, 'create').mockImplementation(async (...args) => {
    entered = true;
    await gate;
    return create(...args);
  });
  const scope = { workspace: join(root, 'workspace') };
  const request = rpc(directory, 'drafts.create', { scope, text: 'Сохранить перед выходом' });
  const rejected = expect(request).rejects.toThrow('closed the connection');
  await eventually(() => entered);
  let closed = false;
  const closing = service.close().then(() => {
    closed = true;
  });
  const repeated = service.close();
  try {
    await setImmediate();
    expect(closed).toBe(false);
    expect(await readFile(join(directory, 'daemon.lock'), 'utf8')).toBe(String(process.pid));
    await expect(serve(config, directory)).rejects.toThrow('already owns');
    await expect(
      service.app.runtime.start({
        message: 'Поздний запуск',
        workspace: scope.workspace,
        requestKey: 'after-close',
      }),
    ).rejects.toThrow('закрывается');
  } finally {
    finish();
    await Promise.all([closing, repeated, rejected]);
  }
  const next = await serve(config, directory);
  cleanup(() => next.close());
  expect(await rpc(directory, 'drafts.list', { scope })).toMatchObject({
    items: [{ preview: 'Сохранить перед выходом' }],
    total: 1,
  });
});

it('ошибка остановки одного модуля не пропускает закрытие остальных ресурсов', async () => {
  const root = await temporary();
  const config = await configDirectory(root, 'http://127.0.0.1:1/v1');
  const directory = join(root, 'state');
  const service = await serve(config, directory);
  vi.spyOn(service.app.runtime, 'close').mockRejectedValue(new Error('Ошибка диска'));
  const learning = vi.spyOn(service.app.learning, 'close');
  const nest = vi.spyOn(service.app.nest, 'close');
  const diagnostics = vi.spyOn(service.app.diagnostics, 'close');
  await expect(service.close()).rejects.toThrow('Ошибка закрытия Harness');
  expect(learning).toHaveBeenCalledOnce();
  expect(nest).toHaveBeenCalledOnce();
  expect(diagnostics).toHaveBeenCalledOnce();
  await expect(service.close()).rejects.toThrow('Ошибка закрытия Harness');
  expect(nest).toHaveBeenCalledOnce();
  const next = await serve(config, directory);
  await next.close();
});
