// Headless Chromium over the DevTools protocol with core modules only (child_process + the
// global WebSocket), shared by scripts/park-check.mjs and scripts/park-bench.mjs (phase 4
// step 15). Finds the binary, launches it with a throwaway profile, connects, and cleans up.
//
//   CHROMIUM=/path/to/chromium   the binary or a directory holding one
//   (default: the sidecar's known install locations — Playwright's folder, the macOS app
//   bundles, /usr/bin — then `chromium` on PATH)

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromium as findInstalled } from '../../sidecar/browser/cdp.js';

// The flags the park check always uses: software GL, no sandbox, a fixed window.
export const BASE_FLAGS = Object.freeze(['--headless=new', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800']);

// The flags that give headless Chromium a software WebGPU adapter (SwiftShader through
// Dawn). A loopback page is a secure context, so `navigator.gpu` appears with them.
export const WEBGPU_FLAGS = Object.freeze(['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan']);

// The sidecar's discovery ($CHROMIUM, then the known install locations, macOS app
// bundles included); `chromium` on PATH stays the last resort for Linux images.
export async function findChromium() {
  return (await findInstalled()) || 'chromium';
}

// Minimal CDP client over the global WebSocket.
export function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    const listeners = new Map();
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        const msg = { id: ++id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        ws.send(JSON.stringify(msg));
        return new Promise((res, rej) => waiting.set(msg.id, { res, rej }));
      },
      on(method, fn) {
        listeners.set(method, [...(listeners.get(method) || []), fn]);
      },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', (e) => reject(new Error(`cdp socket error: ${e.message || e}`)));
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w.rej(new Error(m.error.message));
        else w.res(m.result);
      } else if (m.method) {
        for (const fn of listeners.get(m.method) || []) fn(m.params, m.sessionId);
      }
    });
  });
}

// Launches Chromium with a fresh profile and returns the process, its DevTools URL and the
// profile directory (remove it with `removeWithRetry` after `stopChromium`).
export async function launchChromium({ flags = BASE_FLAGS, extraFlags = [] } = {}) {
  const bin = await findChromium();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-chrome-'));
  const chrome = spawn(bin, [...flags, ...extraFlags, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chromium did not announce a DevTools endpoint')), 15000);
    chrome.stderr.on('data', (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    chrome.on('exit', (code) => reject(new Error(`chromium exited (${code}); set CHROMIUM to a binary`)));
  });
  return { bin, chrome, wsUrl, profile };
}

// Opens a page in its own target and returns `evaluate`, the collected console errors and
// logs, and the session id for further CDP calls.
export async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const logs = [];
  cdp.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text);
  });
  cdp.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId) return;
    const line = p.args.map((a) => a.value || a.description).join(' ');
    if (p.type === 'error') errors.push(line);
    else logs.push(line);
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  return { targetId, sessionId, evaluate, errors, logs, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

export function stopChromium(chrome) {
  return new Promise((resolve) => {
    if (chrome.exitCode !== null || chrome.signalCode) return resolve();
    const t = setTimeout(resolve, 5000);
    chrome.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    chrome.kill('SIGKILL');
  });
}

// Chromium keeps writing to its profile for a moment after SIGKILL, so the removal is
// forced, recursive and retried; a profile that still cannot be removed is reported, not fatal.
export async function removeWithRetry(dir, { attempts = 8, delayMs = 250, fs = fsp, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (err) {
      last = err;
      await sleep(delayMs);
    }
  }
  console.warn(`profile directory ${dir} could not be removed (${last && last.code ? last.code : last}); remove it by hand`);
  return false;
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
