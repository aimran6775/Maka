// A guarded WebSocket client for the channel adapters (phase 4 step 3): the gateway URL
// a platform hands out is checked by the outbound guard before the socket opens (the
// `wss:` scheme read as `https:` for the check), JSON frames in and out, and a promise
// for the close. Node's global WebSocket (core since Node 22) is the transport; nothing
// else is imported. `WebSocketImpl` is injectable for tests that need a stand-in.

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function openGuardedSocket(url, { netGuard, WebSocketImpl = globalThis.WebSocket, timeoutMs = 15000, onMessage, onClose, log = console } = {}) {
  if (typeof WebSocketImpl !== 'function') throw fail('NO_WEBSOCKET', 'this Node has no WebSocket client');
  const u = new URL(String(url));
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw fail('BAD_SCHEME', `gateway url must be ws(s), got ${u.protocol}`);
  const asHttp = new URL(u.toString());
  asHttp.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  if (netGuard) await netGuard.assert(asHttp.toString());
  const ws = new WebSocketImpl(u.toString());
  let closed = false;
  const closePromise = new Promise((resolve) => {
    ws.addEventListener('close', (ev) => {
      closed = true;
      if (onClose) onClose({ code: ev && ev.code, reason: ev && ev.reason ? String(ev.reason) : '' });
      resolve({ code: ev && ev.code, reason: ev && ev.reason ? String(ev.reason) : '' });
    });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already gone */ }
      reject(fail('WS_TIMEOUT', `gateway did not open within ${timeoutMs} ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(fail('WS_ERROR', 'gateway connection failed')); }, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let data = null;
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
    } catch {
      return;
    }
    try {
      onMessage(data);
    } catch (err) {
      log.error && log.error('gateway message handler failed:', err);
    }
  });
  ws.addEventListener('error', () => { /* the close event follows */ });
  return {
    send(obj) {
      if (closed) throw fail('WS_CLOSED', 'gateway socket is closed');
      ws.send(JSON.stringify(obj));
    },
    close(code = 1000, reason = 'maka stopping') {
      if (!closed) {
        try { ws.close(code, reason); } catch { /* already closing */ }
      }
      return closePromise;
    },
    get closed() {
      return closed;
    },
    closed_: closePromise,
  };
}

export const RECONNECT_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
export function backoffAt(failures) {
  return RECONNECT_BACKOFF_MS[Math.min(Math.max(failures, 1), RECONNECT_BACKOFF_MS.length) - 1];
}
export function sleepUnless(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
