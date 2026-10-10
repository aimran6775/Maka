// The first-run flow (phase 3 step 3): the state behind the park's first-run card and
// the actions it takes. Four steps, each true to what exists: the workspace root (the
// LaCie by default when it is mounted), the judge key (pasted, then verified against the
// provider), the worker (Ollama detected, a model sized to memory pulled; see
// sidecar/ollama.js), and the mission (the Chief Ranger is already at the Peak; the
// mission goes through the same POST /api/mission as the Peak card).
//
//   createSetup({ store, home, configPath, workspaceRoot, env, keystorePath, bus, ollama,
//                 chief, agents, providerStatus, restart, fetch, fs, platform, clock })
//     -> { init(), state(), setWorkspace(root), setKey(provider, key), complete(opts), candidates() }
//
// Changing the workspace root writes config.json and restarts the sidecar in-process
// (`restart()`), because every module took the root at boot; the page reconnects.

import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { makeEvent } from '../shared/events.js';
import { readJson, writeJsonAtomic } from './store.js';
import { setKey as storeKey, resolveKey } from './providers/keys.js';

export const LACIE_VOLUME = '/Volumes/LaCie';
export const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_URLS = { anthropic: 'https://api.anthropic.com/v1/models', openrouter: 'https://openrouter.ai/api/v1/auth/key' };

// Checks a key against the provider with a request that costs nothing: 200 = valid,
// 401 / 403 = invalid, anything else = could not verify (the key is still stored).
export async function verifyKey(provider, key, { fetch: fetchImpl = globalThis.fetch, urls = VERIFY_URLS, timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const url = urls[provider];
  if (!url) return { verified: false, valid: null, reason: `no verification endpoint for ${provider}` };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
    const res = await fetchImpl(url, { headers, signal: ac.signal });
    if (res.ok) return { verified: true, valid: true, reason: null };
    if (res.status === 401 || res.status === 403) return { verified: true, valid: false, reason: `${provider} answered HTTP ${res.status}: the key is not accepted` };
    return { verified: false, valid: null, reason: `${provider} answered HTTP ${res.status}; could not verify` };
  } catch (err) {
    return { verified: false, valid: null, reason: `could not reach ${provider}: ${err && err.name === 'AbortError' ? 'timeout' : err.message}` };
  } finally {
    clearTimeout(t);
  }
}

export function createSetup({ store = null, home, configPath, workspaceRoot, env = process.env, keystorePath, bus = null, ollama = null, chief = null, agents = null, providerStatus, restart = null, fetch: fetchImpl = globalThis.fetch, fs = fsp, platform = process.platform, clock = { now: () => Date.now() }, verifyUrls, log = console } = {}) {
  if (!home) throw new TypeError('createSetup needs home');
  const setupFile = path.join(home, 'setup.json');
  const cfgFile = configPath || path.join(home, 'config.json');
  let setup = null; // { version, completedAt, skipped, steps: { workspace, judge, worker, mission } }
  const emit = (type, payload) => bus && bus.emit(makeEvent(type, payload, { ts: clock.now() }));

  async function save() {
    await writeJsonAtomic(setupFile, setup, { fs });
  }

  async function markStep(step, detail = '') {
    setup.steps[step] = { doneAt: clock.now(), detail };
    await save();
    emit('setup.changed', { step, change: 'done', detail });
  }

  // Where the workspace could live: the LaCie when it is mounted (the owner's drive,
  // docs/KICKOFF_BRIEF.md), the home directory, and whatever config.json already names.
  async function candidates() {
    const out = [];
    const lacie = { path: path.join(LACIE_VOLUME, 'Maka', 'workspace'), label: 'LaCie external drive', volume: LACIE_VOLUME, mounted: false, writable: false, default: false };
    if (platform === 'darwin') {
      try {
        const st = await fs.stat(LACIE_VOLUME);
        lacie.mounted = st.isDirectory();
        if (lacie.mounted) {
          await fs.access(LACIE_VOLUME, fs.constants ? fs.constants.W_OK : 2);
          lacie.writable = true;
        }
      } catch {
        /* not mounted or not writable */
      }
      out.push(lacie);
    }
    out.push({ path: path.join(os.homedir(), 'Maka', 'workspace'), label: 'home directory', volume: os.homedir(), mounted: true, writable: true, default: false });
    const current = workspaceRoot && !out.some((c) => c.path === workspaceRoot) ? { path: workspaceRoot, label: 'current root', volume: null, mounted: true, writable: true, default: false } : null;
    if (current) out.unshift(current);
    const pick = out.find((c) => c.label === 'LaCie external drive' && c.mounted && c.writable) || out.find((c) => c.label === 'current root') || out.find((c) => c.label === 'home directory');
    if (pick) pick.default = true;
    return out;
  }

  const api = {
    async init() {
      setup = await readJson(setupFile, null, { fs });
      if (!setup || typeof setup !== 'object' || !setup.steps) setup = { version: 1, completedAt: null, skipped: false, steps: {} };
      return this;
    },
    // Everything the first-run card shows.
    async state() {
      const providers = providerStatus ? await providerStatus() : {};
      const chiefRecord = agents ? agents.list().find((a) => a.role === 'chief_ranger') || null : null;
      const mission = chief ? chief.state().mission : null;
      return {
        firstRun: !setup.completedAt,
        completedAt: setup.completedAt,
        skipped: Boolean(setup.skipped),
        steps: setup.steps,
        workspace: { root: workspaceRoot, configPath: cfgFile, candidates: await candidates() },
        judge: { anthropic: Boolean(providers.anthropic && providers.anthropic.configured), openrouter: Boolean(providers.openrouter && providers.openrouter.configured), verified: setup.steps.judge ? setup.steps.judge.detail : null },
        worker: ollama ? ollama.summary() : null,
        mission: { chief: chiefRecord ? { id: chiefRecord.id, name: chiefRecord.name, zoneId: chiefRecord.zoneId || chiefRecord.roomId } : null, briefed: Boolean(mission), status: mission ? mission.status : null },
        home,
      };
    },
    candidates,
    // Writes workspaceRoot into config.json (merged with what is there) after proving
    // the directory can be created and written to; a changed root restarts the sidecar.
    async setWorkspace(root) {
      if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root.trim())) throw fail('BAD_REQUEST', 'root must be an absolute path');
      const target = path.resolve(root.trim());
      try {
        await fs.mkdir(target, { recursive: true });
        const probe = path.join(target, `.maka-write-test-${process.pid}`);
        await fs.writeFile(probe, 'ok');
        await fs.rm(probe, { force: true });
      } catch (err) {
        throw fail('WORKSPACE_UNWRITABLE', `${target} cannot be used: ${err.code || err.message}`);
      }
      let cfg = {};
      try {
        cfg = (await readJson(cfgFile, {}, { fs })) || {};
      } catch (err) {
        throw fail('CONFIG_UNREADABLE', `${cfgFile} could not be read: ${err.message}`);
      }
      await writeJsonAtomic(cfgFile, { ...cfg, workspaceRoot: target }, { fs });
      await markStep('workspace', target);
      const changed = target !== path.resolve(workspaceRoot || '');
      const envPinned = Boolean(env.MAKA_WORKSPACE && String(env.MAKA_WORKSPACE).trim());
      let restarting = false;
      if (changed && !envPinned && typeof restart === 'function') {
        restarting = true;
        emit('setup.changed', { step: 'workspace', change: 'restarting', detail: target });
        restart();
      }
      return { root: target, configPath: cfgFile, changed, restarting, envPinned, note: envPinned ? `MAKA_WORKSPACE=${env.MAKA_WORKSPACE} is set in the environment and wins over config.json; unset it to use ${target}` : changed && !restarting ? 'restart the sidecar to use the new root' : null };
    },
    // Stores the judge key (the Keychain through the broker in the app, the 0600 file
    // in development) after checking it with the provider. An invalid key is refused.
    async setKey(provider, key) {
      if (!['anthropic', 'openrouter'].includes(provider)) throw fail('BAD_REQUEST', 'provider must be anthropic or openrouter');
      if (typeof key !== 'string' || !key.trim()) throw fail('BAD_REQUEST', 'key is required');
      const trimmed = key.trim();
      const v = await verifyKey(provider, trimmed, { fetch: fetchImpl, urls: verifyUrls });
      if (v.verified && v.valid === false) throw fail('KEY_INVALID', v.reason);
      await storeKey(provider, trimmed, { env, keystorePath });
      const stored = await resolveKey(provider, { env, keystorePath });
      const fromEnv = stored && env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'] && String(env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY']).trim() === stored && stored !== trimmed;
      const detail = v.verified ? `${provider}: verified` : `${provider}: stored, not verified (${v.reason})`;
      await markStep('judge', detail);
      return { provider, stored: true, verified: v.verified, reason: v.reason, note: fromEnv ? `the environment variable is set and wins over the stored key` : null };
    },
    async complete({ skipped = false } = {}) {
      setup.completedAt = clock.now();
      setup.skipped = Boolean(skipped);
      await save();
      emit('setup.changed', { step: 'all', change: skipped ? 'skipped' : 'completed', detail: '' });
      return api.state();
    },
    async reset() {
      setup = { version: 1, completedAt: null, skipped: false, steps: {} };
      await save();
      return api.state();
    },
    async noteMission() {
      if (!setup.steps.mission) await markStep('mission', '');
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
