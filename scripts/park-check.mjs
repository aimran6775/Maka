#!/usr/bin/env node
// Headless park check (manual, not part of test:fast): boots a test sidecar with a scripted
// provider, opens the park in headless Chromium over the DevTools protocol (core modules
// only: child_process + the global WebSocket), briefs the Chief so a plan, hires and a
// delegation happen, and reports what the page says: renderer status, bodies in the scene,
// console errors. Exit code 1 on page errors or a missing renderer.
//
//   CHROMIUM=/path/to/chromium node scripts/park-check.mjs
//   PARK_CHECK_SHOT=/tmp/first-run.png  also saves a screenshot of the first-run card
//   (default: /opt/pw-browsers/chromium or `chromium` on PATH)

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../test/helpers/test-server.js';
import { fakeProvider, text, toolCall, end } from '../test/helpers/fake-provider.js';
import { startFakeOllama } from '../test/helpers/fake-ollama.js';

const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';

async function findChromium() {
  for (const p of [CHROMIUM, path.join(CHROMIUM, 'chrome'), path.join(CHROMIUM, 'chromium')]) {
    try {
      const st = await fsp.stat(p);
      if (st.isFile()) return p;
      if (st.isDirectory()) {
        for (const name of await fsp.readdir(p)) {
          if (/^chrom/.test(name)) {
            const inner = await findChromiumIn(path.join(p, name));
            if (inner) return inner;
          }
        }
      }
    } catch {
      /* next */
    }
  }
  return 'chromium';
}
async function findChromiumIn(dir) {
  try {
    const st = await fsp.stat(dir);
    if (st.isFile()) return dir;
    for (const name of await fsp.readdir(dir)) {
      if (name === 'chrome' || name === 'chromium' || name === 'headless_shell') {
        const f = path.join(dir, name);
        if ((await fsp.stat(f)).isFile()) return f;
      }
    }
    for (const name of await fsp.readdir(dir)) {
      const sub = path.join(dir, name);
      if ((await fsp.stat(sub)).isDirectory()) {
        const found = await findChromiumIn(sub);
        if (found) return found;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Minimal CDP client over the global WebSocket.
function connectCdp(wsUrl) {
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

const PLAN = { summary: 'One venture: lanterns.', ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'Paper lanterns on Etsy.', budgetUsd: 2, roles: [{ specialty: 'scout' }], tasks: [{ id: 't1', title: 'Research', specialty: 'scout', brief: 'Find five shops.', budgetUsd: 1 }] }] };

async function main() {
  const chiefProvider = fakeProvider([
    [...toolCall('p1', 'plan.submit', PLAN), end('tool_use', { inputTokens: 100, outputTokens: 20 })],
    [...toolCall('h1', 'crew.hire', { name: 'Ada', specialty: 'scout', venture: 'lantern-co' }), end('tool_use', { inputTokens: 100, outputTokens: 20 })],
    (req) => {
      const hire = JSON.parse(req.messages.at(-1).content[0].content);
      return [...toolCall('d1', 'delegate', { toAgentId: hire.agentId, brief: 'Find five shops.', budgetUsd: 1 }), end('tool_use', { inputTokens: 100, outputTokens: 20 })];
    },
    [text('Delegated.'), end()],
    [text('Noted.'), end()],
  ], { name: 'anthropic' });
  const makeProvider = async (name, opts) => (name === 'anthropic'
    ? { provider: chiefProvider, model: opts.model, price: { inputPerMTok: 4, outputPerMTok: 20 } }
    : { provider: fakeProvider([[text('Scouting… '), async () => new Promise((r) => setTimeout(r, 4000)), text('five shops found'), end()]], { name }), model: 'worker', price: null });
  // The first-run card (phase 3 step 3) is wired with a fake Ollama so the page shows it,
  // and completed through the API below so the rest of the check sees the park.
  const fakeOllama = await startFakeOllama({ models: [{ name: 'qwen2.5:7b', size: 4 * 1024 ** 3 }] });
  const srv = await startTestServer({ makeProvider, withChief: true, maxConcurrent: 3, ollama: fakeOllama.url, setup: { platform: 'linux' } });
  const bin = await findChromium();
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'maka-chrome-'));
  const chrome = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let wsUrl = null;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chromium did not announce a DevTools endpoint')), 15000);
    chrome.stderr.on('data', (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) {
        wsUrl = m[1];
        clearTimeout(t);
        resolve();
      }
    });
    chrome.on('exit', (code) => reject(new Error(`chromium exited (${code}); set CHROMIUM to a binary`)));
  });
  const cdp = await connectCdp(wsUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  const logs = [];
  cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text));
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') errors.push(p.args.map((a) => a.value || a.description).join(' ')); else logs.push(p.args.map((a) => a.value || a.description).join(' ')); });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: srv.url + '/' }, sessionId);
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const statusText = () => evaluate("document.getElementById('status').textContent");
  for (let i = 0; i < 60; i++) {
    const t = await statusText();
    if (/ranger ready|ranger static|ranger missing|park: renderer/.test(t)) break;
    await wait(500);
  }
  console.log('status before mission:', await statusText());
  const firstRunShown = await evaluate("Boolean(document.querySelector('.firstrun')) && !document.querySelector('.firstrun-host').hidden");
  const firstRunSteps = await evaluate("[...document.querySelectorAll('.firstrun .fr-head')].map((n) => n.textContent)");
  console.log('first-run card:', firstRunShown ? 'shown' : 'NOT SHOWN', JSON.stringify(firstRunSteps));
  if (process.env.PARK_CHECK_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fsp.writeFile(process.env.PARK_CHECK_SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', process.env.PARK_CHECK_SHOT);
  }
  await srv.post('/api/setup/complete', { skipped: true });
  await wait(800);
  const firstRunHidden = await evaluate("document.querySelector('.firstrun-host').hidden");
  console.log('first-run card after skip:', firstRunHidden ? 'hidden' : 'STILL SHOWN');
  // Brief the Chief through the API; the page should show the crew grow and move.
  const r = await srv.post('/api/mission', { text: 'Sell paper lanterns online.', budgetUsd: 3, horizon: '30 days' });
  console.log('mission:', r.status, r.body.mission && r.body.mission.status);
  await srv.runs.waitForIdle();
  await wait(1500);
  const bodiesBefore = await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().bodies()) : null');
  console.log('bodies after mission:', bodiesBefore);
  const summary = await evaluate(`(async () => { const r = await fetch('/api/state'); const s = await r.json(); return { agents: s.layout.agents.map((a) => a.id + ':' + (a.role || 'ranger')), rooms: s.layout.rooms.map((r) => r.id), work: s.work.recent.map((w) => w.status), plan: s.mission.plan && s.mission.plan.version }; })()`);
  console.log('state after mission:', JSON.stringify(summary));
  console.log('status after mission:', await statusText());
  const bodies = JSON.parse((await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().bodies()) : "[]"')) || '[]');
  console.log('bodies:', JSON.stringify(bodies));
  console.log('console errors:', errors.length ? errors : 'none');
  if (logs.length) console.log('console logs:', logs.slice(0, 10));
  const ok = errors.length === 0 && /ranger (ready|static)/.test(await statusText()) && bodies.length === summary.agents.length && bodies.some((b) => b.role === 'chief_ranger') && firstRunShown && firstRunSteps.length === 4 && firstRunHidden;
  // Cleanup never decides the verdict: the check passed or failed above. Chromium keeps
  // writing to its profile for a moment after SIGKILL, so the removal is forced,
  // recursive and retried; a profile that still cannot be removed is reported, not fatal.
  cdp.close();
  await stopChromium(chrome);
  await srv.close();
  await fakeOllama.close();
  await removeWithRetry(profile);
  console.log(ok ? 'PARK CHECK OK' : 'PARK CHECK FAILED');
  process.exit(ok ? 0 : 1);
}

function stopChromium(chrome) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
