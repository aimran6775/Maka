// A fake DevTools endpoint for the protocol layer: a WebSocket server written on
// node:http (handshake, frame parsing, text frames, close) that answers CDP methods from
// a handler table and can push events. Test-only; it never pretends to be a browser.
//
//   const cdp = await startFakeCdp({ handlers: { 'Target.createTarget': () => ({ targetId: 't1' }) } });
//   cdp.wsUrl, cdp.calls (every { id, method, params, sessionId }), cdp.emit(method, params, sessionId),
//   cdp.dropAll() (closes every socket), cdp.close()
import http from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Parses as many complete frames as `buf` holds; returns { frames, rest }.
function decodeFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = Boolean(b1 & 0x80);
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export async function startFakeCdp({ handlers = {}, latencyMs = 0 } = {}) {
  const sockets = new Set();
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeChrome/0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: api.wsUrl }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    const send = (obj) => {
      if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(obj)));
    };
    socket.ws = { send };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x8) {
          socket.write(encodeFrame('', 0x8));
          socket.end();
          sockets.delete(socket);
          return;
        }
        if (f.opcode === 0x9) {
          socket.write(encodeFrame(f.payload.toString(), 0xa));
          continue;
        }
        if (f.opcode !== 0x1) continue;
        let msg;
        try {
          msg = JSON.parse(f.payload.toString('utf8'));
        } catch {
          continue;
        }
        calls.push({ id: msg.id, method: msg.method, params: msg.params || {}, sessionId: msg.sessionId });
        const reply = async () => {
          const h = handlers[msg.method];
          if (!h) return send({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` }, sessionId: msg.sessionId });
          try {
            const result = await h(msg.params || {}, msg.sessionId, { emit: api.emit });
            if (result === undefined) return; // the handler chose not to answer
            send({ id: msg.id, result, sessionId: msg.sessionId });
          } catch (err) {
            send({ id: msg.id, error: { code: err.code || -32000, message: err.message }, sessionId: msg.sessionId });
          }
        };
        if (latencyMs) setTimeout(reply, latencyMs);
        else reply();
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const api = {
    wsUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    httpUrl: `http://127.0.0.1:${port}`,
    calls,
    handlers,
    emit(method, params = {}, sessionId) {
      for (const s of sockets) s.ws.send(sessionId ? { method, params, sessionId } : { method, params });
    },
    dropAll() {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    async close() {
      api.dropAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}
