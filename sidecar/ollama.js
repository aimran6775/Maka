// Ollama management (phase 3 steps 3 and 4): detect the local worker server and the
// install, list what is pulled, size a model to the machine's memory, pull with real
// progress, start the server, remove a model. Core modules only; every number shown
// comes from Ollama's API or the OS, and every "not here" is said plainly.
//
//   createOllama({ env, fetch, bus, clock, os, fs, spawn, exec, log })
//     -> { host, status(), summary(), recommend(), pull(model), start(), remove(model) }
//
// Memory: `os.totalmem()` / `os.freemem()` as the OS reports them (on macOS "free" is
// small by design because the kernel caches aggressively, so the recommendation is
// sized on total memory with a headroom rule and "free" is shown as a diagnostic). The
// candidates are tool-capable models from Ollama's library with their approximate
// download sizes; a pull reports the exact bytes as they arrive.

import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { makeEvent } from '../shared/events.js';
import { ollamaHost, OLLAMA_PROBE_TIMEOUT_MS } from './providers/ollama.js';

export const GB = 1024 ** 3;
// Tool-capable local models, largest first. `approxBytes` is the download size Ollama's
// library lists (approximate until pulled); `needsBytes` is the resident footprint plus
// context the model needs to run; a machine is a fit when half its memory covers that,
// leaving the other half to the app, the browser and the OS (docs/KICKOFF_BRIEF.md,
// Hardware: one ~7-8B 4-bit model on 16 GB).
export const CANDIDATES = Object.freeze([
  Object.freeze({ name: 'qwen2.5:14b', approxBytes: 9.0 * GB, needsBytes: 11 * GB, parameters: '14B' }),
  Object.freeze({ name: 'qwen2.5:7b', approxBytes: 4.7 * GB, needsBytes: 6.5 * GB, parameters: '7B' }),
  Object.freeze({ name: 'qwen2.5:3b', approxBytes: 1.9 * GB, needsBytes: 3 * GB, parameters: '3B' }),
  Object.freeze({ name: 'qwen2.5:1.5b', approxBytes: 1.0 * GB, needsBytes: 1.6 * GB, parameters: '1.5B' }),
]);
export const INSTALL_HINTS = Object.freeze({
  darwin: 'Install Ollama from https://ollama.com/download (the Ollama.app) or `brew install ollama`, then start it.',
  linux: 'Install Ollama with `curl -fsSL https://ollama.com/install.sh | sh`, then `ollama serve`.',
  win32: 'Install Ollama from https://ollama.com/download, then start it.',
});

// Pure: the largest candidate that fits half the machine's memory, with the fit of
// every candidate for the diagnostics card.
export function recommend({ totalBytes, freeBytes, candidates = CANDIDATES }) {
  const budget = totalBytes / 2;
  const fits = candidates.map((c) => ({ ...c, fits: c.needsBytes <= budget, headroomBytes: Math.round(budget - c.needsBytes) }));
  const pick = fits.find((c) => c.fits) || null;
  return { budgetBytes: Math.round(budget), totalBytes, freeBytes, recommended: pick ? pick.name : null, candidates: fits, note: pick ? `${pick.name} needs about ${(pick.needsBytes / GB).toFixed(1)} GB resident; half of ${(totalBytes / GB).toFixed(0)} GB is ${(budget / GB).toFixed(0)} GB` : `no candidate fits half of ${(totalBytes / GB).toFixed(1)} GB; the smallest needs ${(candidates.at(-1).needsBytes / GB).toFixed(1)} GB` };
}

async function whichOllama({ env, fs, platform }) {
  const found = { binary: null, app: null };
  const dirs = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of ['/opt/homebrew/bin', '/usr/local/bin', ...dirs]) {
    const p = `${d}/ollama`;
    try {
      if ((await fs.stat(p)).isFile()) {
        found.binary = p;
        break;
      }
    } catch {
      /* next */
    }
  }
  if (platform === 'darwin') {
    for (const p of ['/Applications/Ollama.app', `${env.HOME || os.homedir()}/Applications/Ollama.app`]) {
      try {
        if ((await fs.stat(p)).isDirectory()) {
          found.app = p;
          break;
        }
      } catch {
        /* next */
      }
    }
  }
  return found;
}

export function createOllama({ env = process.env, fetch: fetchImpl = globalThis.fetch, bus = null, clock = { now: () => Date.now() }, fs = fsp, osImpl = os, spawn = spawnChild, platform = process.platform, log = console, probeTimeoutMs = OLLAMA_PROBE_TIMEOUT_MS } = {}) {
  const host = ollamaHost(env);
  let last = { at: 0, reachable: false, version: null, models: [], problem: 'not probed yet' };
  let pulling = null; // { model, status, completed, total, startedAt }
  let installed = null;
  const emit = (type, payload) => bus && bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  async function getJson(path, { timeoutMs = probeTimeoutMs } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${host}${path}`, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function probe() {
    try {
      const [tags, version] = await Promise.all([getJson('/api/tags'), getJson('/api/version').catch(() => null)]);
      const models = (Array.isArray(tags.models) ? tags.models : []).map((m) => ({ name: m.name || m.model, sizeBytes: Number(m.size) || 0, family: m.details && m.details.family ? m.details.family : null, parameters: m.details && m.details.parameter_size ? m.details.parameter_size : null, quantization: m.details && m.details.quantization_level ? m.details.quantization_level : null, modifiedAt: m.modified_at || null }));
      last = { at: clock.now(), reachable: true, version: version && version.version ? version.version : null, models, problem: null };
    } catch (err) {
      last = { at: clock.now(), reachable: false, version: null, models: [], problem: `ollama not reachable at ${host}: ${err && err.message ? err.message : err}` };
    }
    return last;
  }

  function memory() {
    const totalBytes = osImpl.totalmem();
    const freeBytes = osImpl.freemem();
    return { totalBytes, freeBytes, ...recommend({ totalBytes, freeBytes }) };
  }

  const api = {
    host,
    recommend: () => recommend({ totalBytes: osImpl.totalmem(), freeBytes: osImpl.freemem() }),
    // Everything the Peak and the first-run flow show: probes now.
    async status() {
      await probe();
      if (!installed) installed = await whichOllama({ env, fs, platform });
      return api.summary();
    },
    // The last probe without a new one (for /api/state, which already probes elsewhere).
    summary() {
      const mem = memory();
      const chosen = (env.OLLAMA_MODEL || '').trim() || (last.models[0] ? last.models[0].name : null);
      return {
        host,
        reachable: last.reachable,
        version: last.version,
        problem: last.problem,
        probedAt: last.at,
        models: last.models,
        chosen,
        installed: installed || { binary: null, app: null },
        installHint: INSTALL_HINTS[platform] || INSTALL_HINTS.linux,
        memory: mem,
        pulling: pulling ? { ...pulling } : null,
        // Honest summary line for the UI: what the worker tier will do right now.
        worker: last.reachable ? (chosen ? `ready: ${chosen}` : 'reachable, no model pulled: runs answer NO_MODEL') : 'not reachable: runs answer OLLAMA_UNREACHABLE (no silent fallback)',
      };
    },
    // Pulls a model, streaming Ollama's own progress as ollama.pull events. One at a time.
    async pull(model, { onProgress = null } = {}) {
      if (typeof model !== 'string' || !/^[A-Za-z0-9_.:\/-]{1,120}$/.test(model)) throw fail('BAD_REQUEST', 'model must be a name like qwen2.5:7b');
      if (pulling) throw fail('PULL_ACTIVE', `already pulling ${pulling.model}`, 409);
      pulling = { model, status: 'starting', completed: 0, total: 0, startedAt: clock.now() };
      let lastEmit = 0;
      let lastStatus = '';
      const report = (status, completed, total, done, error) => {
        pulling = pulling ? { ...pulling, status, completed, total } : pulling;
        const now = clock.now();
        if (!done && status === lastStatus && now - lastEmit < 1000) return;
        lastEmit = now;
        lastStatus = status;
        const payload = { model, status, completed, total, done };
        if (error) payload.error = error;
        emit('ollama.pull', payload);
        if (onProgress) onProgress(payload);
      };
      try {
        report('starting', 0, 0, false);
        const res = await fetchImpl(`${host}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let completed = 0;
        let total = 0;
        let finished = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            if (msg.error) throw new Error(String(msg.error));
            if (typeof msg.total === 'number') total = msg.total;
            if (typeof msg.completed === 'number') completed = msg.completed;
            if (msg.status === 'success') finished = true;
            report(String(msg.status || ''), completed, total, false);
          }
        }
        if (!finished) throw new Error('pull ended without success');
        await probe();
        report('success', completed, total, true);
        return { model, ok: true, models: last.models };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        report('failed', pulling ? pulling.completed : 0, pulling ? pulling.total : 0, true, message);
        throw fail('PULL_FAILED', `pulling ${model} failed: ${message}`);
      } finally {
        pulling = null;
      }
    },
    // Starts the server when it is installed and not running: the macOS app, else
    // `ollama serve` detached. Waits up to `waitMs` for it to answer.
    async start({ waitMs = 15000 } = {}) {
      await probe();
      if (last.reachable) return { started: false, reachable: true, how: 'already running' };
      installed = await whichOllama({ env, fs, platform });
      let how;
      if (platform === 'darwin' && installed.app) {
        spawn('open', ['-a', installed.app], { stdio: 'ignore', detached: true }).unref();
        how = `open -a ${installed.app}`;
      } else if (installed.binary) {
        const child = spawn(installed.binary, ['serve'], { stdio: 'ignore', detached: true, env: { ...env } });
        child.unref();
        how = `${installed.binary} serve`;
      } else {
        throw fail('NOT_INSTALLED', `Ollama is not installed. ${INSTALL_HINTS[platform] || INSTALL_HINTS.linux}`);
      }
      const deadline = clock.now() + waitMs;
      while (clock.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        await probe();
        if (last.reachable) break;
      }
      return { started: true, reachable: last.reachable, how };
    },
    async remove(model) {
      if (typeof model !== 'string' || !model.trim()) throw fail('BAD_REQUEST', 'model is required');
      const res = await fetchImpl(`${host}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!res.ok) throw fail('REMOVE_FAILED', `removing ${model} failed: HTTP ${res.status}`, res.status === 404 ? 404 : 502);
      await probe();
      return { model, removed: true, models: last.models };
    },
  };
  return api;
}

function fail(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}
