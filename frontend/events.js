import { EVENT_TYPES } from '../shared/events.js';

// SSE client with reconnect and Last-Event-ID resume. Calls onEvent(event) for every
// frame and onStatus(connected: boolean) on changes.

export function connectEvents({ onEvent, onStatus, since = 0 }) {
  let lastSeq = since;
  let es = null;
  let closed = false;
  let retry = 1000;

  function open() {
    if (closed) return;
    es = new EventSource(`/api/events?since=${lastSeq}`);
    es.onopen = () => {
      retry = 1000;
      onStatus(true);
    };
    es.onerror = () => {
      onStatus(false);
      es.close();
      if (!closed) setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
    };
    // Each event type is a named SSE event; one generic handler covers them all.
    es.onmessage = handle;
    for (const type of EVENT_TYPES) es.addEventListener(type, handle);
  }

  function handle(msg) {
    let event;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
    onEvent(event);
  }

  open();
  return {
    close() {
      closed = true;
      if (es) es.close();
    },
    get lastSeq() {
      return lastSeq;
    },
  };
}
