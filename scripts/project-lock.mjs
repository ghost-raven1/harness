import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './build-state.mjs';

const busy = () => new Error('Подготовка уже открыта в другом окне. Дождитесь её завершения.');
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Учитывает старый PID-файл; пустой файл прежней версии восстанавливается после короткой выдержки. */
async function checkLegacyLock(path) {
  try {
    const content = await readFile(path, 'utf8');
    let pid;
    try {
      const parsed = JSON.parse(content);
      // Новый mutex уже захвачен ОС: прежний PID мог быть повторно выдан другому процессу.
      if (parsed?.protocol === 2) return;
      pid = typeof parsed === 'number' ? parsed : parsed?.pid;
    } catch {
      /* Старый установщик мог прерваться до записи PID. */
    }
    if (Number.isInteger(pid) && pid > 0) {
      if (alive(pid)) throw busy();
    } else if (Date.now() - (await stat(path)).mtimeMs < 30000) throw busy();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** ОС освобождает локальный mutex при аварии; удаление устаревшего файла не служит захватом замка. */
export async function withProjectLock(root, work) {
  const canonical = await realpath(root);
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const port = 20000 + (createHash('sha256').update(key).digest().readUInt32BE(0) % 20000);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
    socket.end();
  });
  try {
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, done);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE')
      throw new Error(
        'Локальный канал подготовки занят (127.0.0.1:' +
          port +
          '). Дождитесь завершения другой подготовки.',
      );
    throw error;
  }
  const path = join(canonical, '.tools', 'prepare.lock');
  const owner = { protocol: 2, pid: process.pid, token: randomUUID() };
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error('Подготовка прервана. Можно запустить её снова.'));
  let written = false;
  try {
    await mkdir(join(canonical, '.tools'), { recursive: true });
    await checkLegacyLock(path);
    await writeJsonAtomic(path, owner);
    written = true;
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    return await work({
      signal: controller.signal,
      async assertOwned() {
        controller.signal.throwIfAborted();
        if (!server.listening || JSON.parse(await readFile(path, 'utf8')).token !== owner.token)
          throw new Error('Владелец подготовки изменился. Повторите запуск.');
      },
    });
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    try {
      if (written) await rm(path, { force: true });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    }
  }
}
