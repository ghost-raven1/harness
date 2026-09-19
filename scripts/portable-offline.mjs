import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

/** Проверка запрещает TCP и HTTP, оставляя только локальные сокеты Harness. */
const denied = () => {
  throw new Error('PORTABLE_SMOKE_NETWORK_DISABLED');
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (
    (typeof input === 'string' && !/^\d+$/.test(input)) ||
    (input && typeof input === 'object' && typeof input.path === 'string')
  )
    return connect.apply(this, args);
  return denied();
};
http.request = http.get = https.request = https.get = denied;
globalThis.fetch = async () => denied();
globalThis.__harnessPortableOffline = true;
syncBuiltinESMExports();
