// Chromium over the DevTools protocol with Node core modules only (phase 2 step 13).
//
//   findChromium({ env, configured })      -> absolute path or null
//   launchChromium({ bin, profileDir, headless, spawn }) -> { wsUrl, pid, kill(), exited }
//   connectCdp(wsUrl, { WebSocket })       -> client { send, on, once, close, closed }
//   openPage(client, { url })              -> page (navigate, read, click, type, upload,
//                                             download, screenshot, facts, bringToFront, close)
//
// The client speaks the flat-session protocol: every call carries the page's sessionId.
// Nothing here knows about Rangers, leashes or traces; sidecar/browser/control.js does.

import { spawn as cpSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const CHROMIUM_CANDIDATES = Object.freeze([
  '/opt/pw-browsers/chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
]);
export const NAVIGATE_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const TEXT_LIMIT = 20_000;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function findIn(p, fs, depth) {
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return null;
  }
  if (st.isFile()) return p;
  if (!st.isDirectory() || depth > 4) return null;
  let names;
  try {
    names = await fs.readdir(p);
  } catch {
    return null;
  }
  for (const name of names) {
    if (['chrome', 'chromium', 'headless_shell', 'Chromium', 'Google Chrome'].includes(name)) {
      const f = path.join(p, name);
      try {
        if ((await fs.stat(f)).isFile()) return f;
      } catch {
        /* next */
      }
    }
  }
  for (const name of names) {
    if (!/chrom/i.test(name)) continue;
    const found = await findIn(path.join(p, name), fs, depth + 1);
    if (found) return found;
  }
  return null;
}

// `configured` (config.json browser.chromiumPath) wins, then $CHROMIUM, then the known
// install locations. A directory (the Playwright browsers folder, say) is searched.
export async function findChromium({ env = process.env, configured = null, fs = fsp } = {}) {
  const order = [configured, env.CHROMIUM, ...CHROMIUM_CANDIDATES].filter(Boolean);
  for (const p of order) {
    const found = await findIn(p, fs, 0);
    if (found) return found;
  }
  return null;
}

// Chromium refuses to run its sandbox as root (containers, CI); only there is it turned
// off. On the owner's Mac the sandbox stays on.
export const runningAsRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

export function chromiumArgs({ profileDir, headless, windowSize = '1280,900', extra = [], noSandbox = runningAsRoot() }) {
  return [
    ...(headless ? ['--headless=new', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] : []),
    ...(noSandbox ? ['--no-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--password-store=basic',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`,
    ...extra,
    'about:blank',
  ];
}

// Spawns a Chromium with its own profile and resolves once it announces its DevTools
// endpoint. `spawn` is injectable for tests.
export function launchChromium({ bin, profileDir, headless = true, spawn = cpSpawn, timeoutMs = 20_000, extraArgs = [] }) {
  if (!bin) return Promise.reject(fail('NO_CHROMIUM', 'no Chromium binary: set browser.chromiumPath in config.json or CHROMIUM in the environment'));
  if (!profileDir) return Promise.reject(new TypeError('launchChromium needs profileDir'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, chromiumArgs({ profileDir, headless, extra: extraArgs }), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(fail('LAUNCH_FAILED', `could not start ${bin}: ${err.message}`));
      return;
    }
    let settled = false;
    let stderr = '';
    const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      reject(fail('LAUNCH_TIMEOUT', `${bin} did not announce a DevTools endpoint within ${timeoutMs}ms${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`));
    }, timeoutMs);
    const onData = (d) => {
      stderr += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          wsUrl: m[1],
          pid: child.pid,
          exited,
          kill() {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          },
        });
      }
    };
    if (child.stderr) child.stderr.on('data', onData);
    if (child.stdout) child.stdout.on('data', onData);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail('LAUNCH_FAILED', `could not start ${bin}: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail('LAUNCH_FAILED', `${bin} exited with ${code} before announcing a DevTools endpoint${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`));
    });
  });
}

// A minimal CDP client over the global WebSocket. Replies resolve by id; events fan out
// to on()/once() listeners; a closed socket rejects everything still pending.
export function connectCdp(wsUrl, { WebSocket: WS = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
  if (typeof WS !== 'function') return Promise.reject(fail('NO_WEBSOCKET', 'this Node has no global WebSocket (Node 22+ is required)'));
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WS(wsUrl);
    } catch (err) {
      reject(fail('CDP_CONNECT', `cannot open ${wsUrl}: ${err.message}`));
      return;
    }
    let nextId = 0;
    let open = false;
    const waiting = new Map();
    const listeners = new Set();
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    const timer = setTimeout(() => {
      if (open) return;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(fail('CDP_CONNECT', `no answer from ${wsUrl} within ${timeoutMs}ms`));
    }, timeoutMs);
    const client = {
      get open() {
        return open;
      },
      closed,
      send(method, params = {}, sessionId) {
        if (!open) return Promise.reject(fail('CDP_CLOSED', `cannot send ${method}: the DevTools socket is closed`));
        const msg = { id: ++nextId, method, params };
        if (sessionId) msg.sessionId = sessionId;
        return new Promise((res, rej) => {
          waiting.set(msg.id, { res, rej, method });
          try {
            ws.send(JSON.stringify(msg));
          } catch (err) {
            waiting.delete(msg.id);
            rej(fail('CDP_SEND', `${method}: ${err.message}`));
          }
        });
      },
      on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      // Resolves with the params of the first event matching `pred(method, params, sessionId)`.
      once(pred, { timeoutMs: t = 10_000, label = 'event' } = {}) {
        return new Promise((res, rej) => {
          const timer2 = setTimeout(() => {
            off();
            rej(fail('CDP_TIMEOUT', `timed out after ${t}ms waiting for ${label}`));
          }, t);
          const off = client.on((method, params, sessionId) => {
            if (!pred(method, params, sessionId)) return;
            clearTimeout(timer2);
            off();
            res(params);
          });
        });
      },
      close() {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    };
    ws.addEventListener('open', () => {
      open = true;
      clearTimeout(timer);
      resolve(client);
    });
    ws.addEventListener('error', (e) => {
      if (!open) {
        clearTimeout(timer);
        reject(fail('CDP_CONNECT', `cannot connect to ${wsUrl}: ${e.message || 'socket error'}`));
      }
    });
    ws.addEventListener('close', () => {
      open = false;
      for (const [, w] of waiting) w.rej(fail('CDP_CLOSED', `${w.method}: the DevTools socket closed`));
      waiting.clear();
      resolveClosed();
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id !== undefined && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) w.rej(fail('CDP_ERROR', `${w.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`));
        else w.res(m.result || {});
      } else if (m.method) {
        for (const fn of listeners) {
          try {
            fn(m.method, m.params || {}, m.sessionId);
          } catch (err) {
            console.error('cdp listener failed:', err);
          }
        }
      }
    });
  });
}

// Browser-side script: finds one element by CSS selector or by visible text / label /
// aria-label / placeholder / value, scrolls it into view and reports its centre.
const LOCATE_JS = `(function (target) {
  function visible(el) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }
  function labelOf(el) {
    const bits = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.value && el.tagName !== 'TEXTAREA' && (el.type === 'submit' || el.type === 'button') ? el.value : ''];
    if (el.id) for (const l of document.querySelectorAll('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]')) bits.push(l.innerText);
    const wrap = el.closest('label'); if (wrap) bits.push(wrap.innerText);
    bits.push(el.innerText || el.textContent || '');
    return bits.filter(Boolean).map((s) => String(s).trim().replace(/\\s+/g, ' ')).filter(Boolean);
  }
  let el = null;
  if (target.selector) el = document.querySelector(target.selector);
  else if (target.text) {
    const want = String(target.text).trim().toLowerCase();
    const all = Array.from(document.querySelectorAll('a, button, input, textarea, select, summary, option, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], label, h1, h2, h3, li, td, th, span, div, p'));
    const scored = [];
    for (const cand of all) {
      if (!visible(cand)) continue;
      const labels = labelOf(cand);
      let score = 0;
      for (const l of labels) { const low = l.toLowerCase(); if (low === want) score = Math.max(score, 3); else if (low.includes(want) && l.length <= want.length + 40) score = Math.max(score, 1); }
      if (!score) continue;
      const interactive = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY|OPTION|LABEL)$/.test(cand.tagName) || cand.getAttribute('role');
      scored.push({ el: cand, score: score * 10 + (interactive ? 5 : 0) - Math.min(4, cand.querySelectorAll('*').length / 50) });
    }
    scored.sort((a, b) => b.score - a.score);
    el = scored.length ? scored[0].el : null;
    if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), type: el.type || '', text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80), editable: el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) };
})`;

// Browser-side script: what a handoff decision needs (sidecar/browser/detect.js).
const FACTS_JS = `(function () {
  const q = (s) => { try { return Boolean(document.querySelector(s)); } catch { return false; } };
  return {
    url: location.href,
    title: document.title || '',
    password: q('input[type=password]'),
    otp: q('input[autocomplete=one-time-code], input[name*=otp i], input[id*=otp i], input[name*=totp i], input[name*=verification i], input[name*=mfa i]'),
    captcha: q('iframe[src*=recaptcha], iframe[src*=hcaptcha], iframe[src*=turnstile], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], #captcha, input[name*=captcha i]'),
    payment: q('input[autocomplete=cc-number], input[autocomplete=cc-csc], input[name*=cardnumber i], input[name*=card_number i], input[id*=cardnumber i], iframe[src*=stripe], iframe[name*=braintree], iframe[src*=paypal], iframe[src*=adyen]'),
    text: ((document.body && document.body.innerText) || '').slice(0, 4000),
    readyState: document.readyState,
  };
})()`;

function flattenTree(nodes, limit) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines = [];
  const seen = new Set();
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  const walk = (node, depth) => {
    if (!node || seen.has(node.nodeId) || lines.length >= limit) return;
    seen.add(node.nodeId);
    const role = node.role && node.role.value;
    const name = node.name && node.name.value ? String(node.name.value).trim() : '';
    const value = node.value && node.value.value !== undefined && node.value.value !== '' ? String(node.value.value) : '';
    const skip = node.ignored || !role || ['none', 'generic', 'InlineTextBox', 'StaticText', 'LineBreak'].includes(role) || (!name && !value && !['textbox', 'button', 'link', 'checkbox', 'radio', 'combobox', 'searchbox', 'heading', 'img'].includes(role));
    if (!skip) lines.push(`${'  '.repeat(Math.min(depth, 12))}${role}${name ? ` "${name.slice(0, 120)}"` : ''}${value ? ` = ${value.slice(0, 80)}` : ''}`);
    for (const id of node.childIds || []) walk(byId.get(id), skip ? depth : depth + 1);
  };
  walk(root, 0);
  return lines;
}

// Attaches to a fresh tab. Every method rejects with a coded error instead of hanging.
export async function openPage(client, { url = 'about:blank', navigateTimeoutMs = NAVIGATE_TIMEOUT_MS } = {}) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => client.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  let loading = false;
  let currentUrl = 'about:blank';
  client.on((method, params, sid) => {
    if (sid !== sessionId) return;
    if (method === 'Page.frameStartedLoading') loading = true;
    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') loading = false;
    if (method === 'Page.frameNavigated' && params.frame && !params.frame.parentId) currentUrl = params.frame.url;
  });

  async function evaluate(expression, { awaitPromise = false } = {}) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw fail('PAGE_SCRIPT', `page script failed: ${(d.exception && d.exception.description) || d.text}`);
    }
    return r.result ? r.result.value : undefined;
  }
  const settle = async (ms) => {
    const until = Date.now() + ms;
    await new Promise((r) => setTimeout(r, 120));
    while (loading && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  };
  async function locate(target) {
    const found = await evaluate(`${LOCATE_JS}(${JSON.stringify({ selector: target.selector || null, text: target.text || null })})`);
    if (!found) throw fail('NOT_FOUND', `nothing on the page matches ${target.selector ? `selector "${target.selector}"` : `"${target.text}"`}`);
    return found;
  }
  async function mouseClick(x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  const page = {
    targetId,
    sessionId,
    url: () => currentUrl,
    evaluate,
    async navigate(target) {
      const load = client.once((m, p, sid) => sid === sessionId && m === 'Page.loadEventFired', { timeoutMs: navigateTimeoutMs, label: `the load of ${target}` });
      load.catch(() => {});
      const r = await send('Page.navigate', { url: target });
      if (r.errorText) throw fail('NAVIGATE_FAILED', `${target}: ${r.errorText}`);
      await load;
      currentUrl = (await evaluate('location.href')) || target;
      return page.summary();
    },
    async summary() {
      const s = await evaluate('({ url: location.href, title: document.title || "" })');
      currentUrl = s.url;
      return s;
    },
    facts: () => evaluate(FACTS_JS),
    async text(limit = TEXT_LIMIT) {
      const t = (await evaluate('(document.body && document.body.innerText) || ""')) || '';
      return t.length > limit ? `${t.slice(0, limit)}\n…[${t.length - limit} more characters]` : t;
    },
    async tree(limit = 400) {
      const { nodes } = await send('Accessibility.getFullAXTree');
      return flattenTree(nodes || [], limit);
    },
    async click(target) {
      const el = await locate(target);
      await mouseClick(el.x, el.y);
      await settle(5000);
      return el;
    },
    async type(target, value, { submit = false, clear = true } = {}) {
      const el = await locate(target);
      if (!el.editable) throw fail('NOT_EDITABLE', `"${el.text || el.tag}" is a ${el.tag}, not a field`);
      await mouseClick(el.x, el.y);
      await evaluate(`${LOCATE_JS}(${JSON.stringify({ selector: target.selector || null, text: target.text || null })}) && (function (t) { const el = document.activeElement; if (!el) return; el.focus(); if (${clear ? 'true' : 'false'} && typeof el.select === 'function') el.select(); })()`);
      await send('Input.insertText', { text: String(value) });
      if (submit) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await settle(5000);
      }
      return el;
    },
    async upload(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw fail('NOT_FOUND', `no file input matches selector "${selector}"`);
      await send('DOM.setFileInputFiles', { nodeId, files });
      return { count: files.length };
    },
    // Downloads land in `dir` under their suggested name; resolves with { path, bytes }.
    async download({ url: href, selector, text }, dir, { timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
      await client.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: dir, eventsEnabled: true });
      // Progress events can arrive before the begin event is awaited; keep them by guid.
      const progress = new Map();
      const offProgress = client.on((m, p) => { if (m === 'Browser.downloadProgress') progress.set(p.guid, p.state); });
      const begun = client.once((m) => m === 'Browser.downloadWillBegin', { timeoutMs, label: 'the download to begin' });
      begun.catch(() => {});
      let start;
      try {
        if (href) {
          const r = await send('Page.navigate', { url: href });
          if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw fail('NAVIGATE_FAILED', `${href}: ${r.errorText}`);
        } else {
          const el = await locate({ selector, text });
          await mouseClick(el.x, el.y);
        }
        start = await begun;
        const until = Date.now() + timeoutMs;
        while (progress.get(start.guid) !== 'completed') {
          if (progress.get(start.guid) === 'canceled') throw fail('DOWNLOAD_CANCELED', `the download of ${start.suggestedFilename} was canceled`);
          if (Date.now() > until) throw fail('CDP_TIMEOUT', `timed out after ${timeoutMs}ms waiting for the download of ${start.suggestedFilename}`);
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        offProgress();
      }
      const safeName = (start.suggestedFilename || 'download').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '') || 'download';
      let dest = path.join(dir, safeName);
      let n = 1;
      while (await fsp.stat(dest).then(() => true, () => false)) dest = path.join(dir, `${path.parse(safeName).name}-${n++}${path.parse(safeName).ext}`);
      await fsp.rename(path.join(dir, start.guid), dest);
      const st = await fsp.stat(dest);
      return { path: dest, bytes: st.size, url: start.url || href || '' };
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    },
    bringToFront: () => send('Page.bringToFront').catch(() => {}),
    async close() {
      try {
        await client.send('Target.closeTarget', { targetId });
      } catch {
        /* already gone */
      }
    },
  };
  if (url && url !== 'about:blank') await page.navigate(url);
  return page;
}
