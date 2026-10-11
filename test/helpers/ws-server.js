// A WebSocket + HTTP server on node:http for the channel fakes (Discord's gateway, Slack's
// Socket Mode): the handshake, frame parsing (masked client frames), text frames, ping /
// pong, close. The same framing as fake-cdp.js, shared so each fake is only its protocol.
// Test-only.
import http from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeFrame(text, opcode = 0x1) {
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

export function decodeFrames(buf) {
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

// onRequest(req, res, body: string) handles HTTP; onSocket(conn, req) gets a WebSocket
// connection: conn.send(obj), conn.close(), conn.onMessage(fn(obj)), conn.onClose(fn).
export async function startWsHttpServer({ onRequest, onSocket, wsPath = null }) {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await onRequest(req, res, Buffer.concat(chunks).toString('utf8'));
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || (wsPath && !req.url.startsWith(wsPath))) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    const listeners = [];
    const closers = [];
    const conn = {
      url: req.url,
      received: [],
      send: (obj) => { if (!socket.destroyed) socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); },
      close: () => { if (!socket.destroyed) { socket.write(encodeFrame('', 0x8)); socket.end(); } sockets.delete(socket); },
      onMessage: (fn) => listeners.push(fn),
      onClose: (fn) => closers.push(fn),
    };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = decodeFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 0x8) {
          if (!socket.destroyed) socket.write(encodeFrame('', 0x8));
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
        conn.received.push(msg);
        for (const fn of listeners) fn(msg);
      }
    });
    const closed = () => { sockets.delete(socket); for (const fn of closers) fn(); };
    socket.on('close', closed);
    socket.on('error', closed);
    onSocket(conn, req);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}${wsPath || '/'}`,
    dropAll: () => { for (const s of sockets) s.destroy(); sockets.clear(); },
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
