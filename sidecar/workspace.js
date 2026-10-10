// Workspace root watcher. The root may live on an external drive, so it can disappear.
// While it is unreachable the sidecar emits workspace.offline, stops the active run and
// refuses new ones; when it is back it emits workspace.online. Nothing is ever written
// elsewhere: the root is the only place agents touch.
//
//   createWorkspaceWatcher({ root, bus, clock, fs, intervalMs, onOffline })
//     -> { start(), stop(), check(), state(): { root, online, since, reason } }

import { promises as fsp } from 'node:fs';
import { makeEvent } from '../shared/events.js';

export function createWorkspaceWatcher({ root, bus, clock = { now: () => Date.now() }, fs = fsp, intervalMs = 5000, onOffline = () => {} }) {
  if (!root || !bus) throw new TypeError('createWorkspaceWatcher needs root and bus');
  let online = null; // unknown until the first check
  let since = clock.now();
  let reason = null;
  let timer = null;

  async function probe() {
    try {
      const st = await fs.stat(root);
      if (!st.isDirectory()) return { ok: false, reason: 'not a directory' };
      await fs.access(root, fs.constants ? fs.constants.W_OK : 2);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.code || err.message };
    }
  }

  async function check() {
    const r = await probe();
    if (r.ok && online !== true) {
      online = true;
      since = clock.now();
      reason = null;
      bus.emit(makeEvent('workspace.online', { root }, { ts: since }));
    } else if (!r.ok && online !== false) {
      online = false;
      since = clock.now();
      reason = r.reason;
      bus.emit(makeEvent('workspace.offline', { root, reason: String(r.reason) }, { ts: since }));
      onOffline(reason);
    }
    return online;
  }

  return {
    check,
    state: () => ({ root, online: online === true, known: online !== null, since, reason }),
    start() {
      if (timer) return;
      timer = setInterval(() => check().catch(() => {}), intervalMs);
      if (timer.unref) timer.unref();
      return check();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
