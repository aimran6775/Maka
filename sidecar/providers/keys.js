// API key resolution. Order: environment variable, then the local keystore file.
//
// Keystore: a JSON object { anthropic: "sk-...", openrouter: "..." } at
// `${MAKA_HOME || .maka}/keystore.json`. It must be a regular file with mode 0600; a
// keystore with looser permissions is refused (and reported) rather than read. Keys never
// leave the sidecar: providerStatus() reports only whether a key exists.
//
// The OS keychain replaces this file when the Tauri shell arrives (not phase 1).

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const KEYSTORE_FILENAME = 'keystore.json';
export const ENV_VARS = Object.freeze({ anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' });

export function defaultKeystorePath(env = process.env) {
  return path.join(env.MAKA_HOME || path.join(process.cwd(), '.maka'), KEYSTORE_FILENAME);
}

async function readKeystore(file, fs) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return { keys: {}, problem: null };
    throw err;
  }
  if (!stat.isFile()) return { keys: {}, problem: `${file} is not a regular file` };
  const mode = stat.mode & 0o777;
  if (process.platform !== 'win32' && mode !== 0o600) {
    return { keys: {}, problem: `${file} has mode ${mode.toString(8)}, expected 600; refusing to read it` };
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    return { keys: {}, problem: `${file} is not valid JSON: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { keys: {}, problem: `${file} must contain a JSON object` };
  }
  return { keys: parsed, problem: null };
}

// Returns the key string or null. `problem` (if any) is attached to a warn callback.
export async function resolveKey(provider, { env = process.env, keystorePath, fs = fsp, warn } = {}) {
  const envVar = ENV_VARS[provider];
  if (envVar && env[envVar] && String(env[envVar]).trim()) return String(env[envVar]).trim();
  const file = keystorePath || defaultKeystorePath(env);
  const { keys, problem } = await readKeystore(file, fs);
  if (problem && typeof warn === 'function') warn(problem);
  const key = keys[provider];
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

// Writes/updates a key in the keystore, creating the file with mode 0600.
export async function setKey(provider, key, { env = process.env, keystorePath, fs = fsp } = {}) {
  const file = keystorePath || defaultKeystorePath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const { keys, problem } = await readKeystore(file, fs);
  if (problem) throw new Error(problem);
  const next = { ...keys };
  if (key) next[provider] = key;
  else delete next[provider];
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(next, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// Human-readable status of the keystore file for diagnostics (never includes keys).
export async function keystoreStatus({ env = process.env, keystorePath, fs = fsp } = {}) {
  const file = keystorePath || defaultKeystorePath(env);
  const { keys, problem } = await readKeystore(file, fs);
  return { path: file, problem, providers: Object.keys(keys).filter((k) => typeof keys[k] === 'string' && keys[k]) };
}
