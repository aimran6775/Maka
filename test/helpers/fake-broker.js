// A fake credential broker: the shell's Unix socket protocol (src-tauri/src/broker.rs)
// over an in-memory map, so the sidecar's keys.js is tested against the real framing.
// Records every request; `fail` makes every answer an ERR; `close()` removes the socket.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

export async function startFakeBroker({ token = 'test-token', initial = {} } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-broker-'));
  const socket = path.join(dir, 'credentials.sock');
  const store = new Map(Object.entries(initial));
  const requests = [];
  const api = { socket, token, store, requests, fail: null, env: { MAKA_CREDENTIALS_SOCKET: socket, MAKA_CREDENTIALS_TOKEN: token } };
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      requests.push(line);
      conn.end(answer(line) + '\n');
    });
  });
  function answer(line) {
    const [given, op, name, b64] = line.split(' ');
    if (given !== token) return 'ERR bad token';
    if (api.fail) return `ERR ${api.fail}`;
    if (op === 'LIST') return `OK ${[...store.keys()].sort().join(',')}`;
    if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return `ERR invalid credential name`;
    if (op === 'GET') return store.has(name) ? `OK ${Buffer.from(store.get(name), 'utf8').toString('base64')}` : 'NONE';
    if (op === 'SET') {
      if (!b64) return 'ERR SET needs a base64 value';
      store.set(name, Buffer.from(b64, 'base64').toString('utf8'));
      return 'OK';
    }
    if (op === 'DEL') {
      store.delete(name);
      return 'OK';
    }
    return `ERR unknown op ${op}`;
  }
  await new Promise((resolve) => server.listen(socket, resolve));
  api.close = async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(dir, { recursive: true, force: true });
  };
  return api;
}
