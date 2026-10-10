// Event bus: validates, numbers (seq), remembers the last N events, and fans out to SSE
// subscribers and in-process listeners. The sidecar's single source of truth for "what
// happened"; the store persists per-run slices of it.

import { assertEvent } from '../shared/events.js';

export function createEventBus({ bufferSize = 2000 } = {}) {
  const buffer = [];
  const listeners = new Set();
  const sseClients = new Set();
  let seq = 0;

  function broadcastSSE(event) {
    const frame = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  return {
    get seq() {
      return seq;
    },
    emit(event) {
      assertEvent(event);
      const numbered = { ...event, seq: ++seq };
      buffer.push(numbered);
      if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
      for (const fn of listeners) {
        try {
          fn(numbered);
        } catch (err) {
          // A listener bug must not break the run; log and continue.
          console.error('event listener failed:', err);
        }
      }
      broadcastSSE(numbered);
      return numbered;
    },
    listen(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    since(lastSeq) {
      return buffer.filter((e) => e.seq > lastSeq);
    },
    recent(n) {
      return buffer.slice(-n);
    },
    // Attaches an HTTP response as an SSE client. Replays events after `lastEventId`.
    attach(req, res, { lastEventId = 0, heartbeatMs = 15000 } = {}) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`: maka events, seq=${seq}\n\n`);
      for (const e of buffer) {
        if (e.seq > lastEventId) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
      sseClients.add(res);
      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* closed */
        }
      }, heartbeatMs);
      const close = () => {
        clearInterval(beat);
        sseClients.delete(res);
      };
      req.on('close', close);
      res.on('close', close);
      return close;
    },
    get clientCount() {
      return sseClients.size;
    },
  };
}
