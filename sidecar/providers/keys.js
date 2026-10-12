// Key resolution. Order: environment variable, then the credential broker when the shell
// gave us one (phase 3 step 2), else the local keystore file.
//
// The broker is the session-scoped handle the macOS shell hands the sidecar: a Unix
// socket (`MAKA_CREDENTIALS_SOCKET`) and a token (`MAKA_CREDENTIALS_TOKEN`) that die
// with the session. Behind it is the Keychain (src-tauri/src/credentials.rs); the
// sidecar never sees the Keychain itself. One request per connection, one line each way:
//   "<token> GET <name>"            → "OK <base64>" | "NONE" | "ERR <message>"
//   "<token> SET <name> <base64>"   → "OK" | "ERR …"
//   "<token> DEL <name>"            → "OK" | "ERR …"
//   "<token> LIST"                  → "OK <name,name,…>" | "ERR …"
// With a broker configured the keystore file is not consulted at all: a broker that
// fails answers "no key" with the problem reported, never a silent fallback to a file.
//
// Keystore (development, and any run without the shell): a JSON object
// { anthropic: "sk-...", openrouter: "..." } at `${MAKA_HOME || .maka}/keystore.json`.
// It must be a regular file with mode 0600; a keystore with looser permissions is
// refused (and reported) rather than read. Keys never leave the sidecar: providerStatus()
// reports only whether a key exists.

import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const KEYSTORE_FILENAME = 'keystore.json';
export const BROKER_SOCKET_VAR = 'MAKA_CREDENTIALS_SOCKET';
export const BROKER_TOKEN_VAR = 'MAKA_CREDENTIALS_TOKEN';
export const BROKER_TIMEOUT_MS = 5000;
// Model providers and, from phase 2, the mail stack and the hosted worker tier. The
// keystore uses the same names as keys: { "cloudflare": "...", "resend": "re_..." }.
export const ENV_VARS = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  resend: 'RESEND_API_KEY',
  resendWebhook: 'RESEND_WEBHOOK_SECRET',
  huggingface: 'HF_TOKEN',
  stripe: 'STRIPE_API_KEY',
  shopify: 'SHOPIFY_ACCESS_TOKEN',
  etsyClientId: 'ETSY_CLIENT_ID',
  metaAds: 'META_ACCESS_TOKEN',
  googleAdsClientId: 'GOOGLE_ADS_CLIENT_ID',
  googleAdsClientSecret: 'GOOGLE_ADS_CLIENT_SECRET',
  googleAdsDeveloperToken: 'GOOGLE_ADS_DEVELOPER_TOKEN',
  braveSearch: 'BRAVE_SEARCH_API_KEY',
  // Phase 3 step 5: the offsite backup to Cloudflare R2 and the snapshot key.
  cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID',
  r2AccessKeyId: 'R2_ACCESS_KEY_ID',
  r2SecretAccessKey: 'R2_SECRET_ACCESS_KEY',
  backupKey: 'MAKA_BACKUP_KEY',
  // Phase 4 step 1: the owner channels' bot tokens (sidecar/channels/).
  telegramBot: 'TELEGRAM_BOT_TOKEN',
  // D170: not a secret — the owner's own handle, so the park knows who to message.
  imessageHandle: 'MAKA_IMESSAGE_HANDLE',
  // D173: the Apple ID the park sends as, when it has one of its own.
  imessageFrom: 'MAKA_IMESSAGE_FROM',
  discordBot: 'DISCORD_BOT_TOKEN',
  slackBot: 'SLACK_BOT_TOKEN',
  slackApp: 'SLACK_APP_TOKEN',
});

export function defaultKeystorePath(env = process.env) {
  return path.join(env.MAKA_HOME || path.join(process.cwd(), '.maka'), KEYSTORE_FILENAME);
}

// The broker the shell configured for this session, or null.
export function brokerFrom(env = process.env) {
  const socket = env[BROKER_SOCKET_VAR] && String(env[BROKER_SOCKET_VAR]).trim();
  const token = env[BROKER_TOKEN_VAR] && String(env[BROKER_TOKEN_VAR]).trim();
  return socket && token ? { socket, token } : null;
}

// One request to the broker. Resolves { ok, value?, names?, error? }; never throws for a
// protocol answer, throws (with code BROKER_UNREACHABLE) when the socket is not there.
export function brokerRequest(broker, op, name, value, { timeoutMs = BROKER_TIMEOUT_MS, connect = net.createConnection } = {}) {
  if (name !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return Promise.resolve({ ok: false, error: `invalid credential name "${name}"` });
  const line = [broker.token, op, name, value !== undefined ? Buffer.from(String(value), 'utf8').toString('base64') : undefined].filter((x) => x !== undefined).join(' ') + '\n';
  return new Promise((resolve, reject) => {
    const fail = (code, message) => {
      const e = new Error(message);
      e.code = code;
      reject(e);
    };
    let buf = '';
    let settled = false;
    const sock = connect(broker.socket);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fail('BROKER_TIMEOUT', `credential broker did not answer within ${timeoutMs} ms`);
    }, timeoutMs);
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      const reply = text.replace(/\r?\n$/, '');
      if (reply === 'NONE') return resolve({ ok: true, value: null });
      if (reply === 'OK') return resolve({ ok: true });
      if (reply.startsWith('OK ')) {
        const rest = reply.slice(3);
        if (op === 'LIST') return resolve({ ok: true, names: rest.split(',').map((s) => s.trim()).filter(Boolean) });
        return resolve({ ok: true, value: Buffer.from(rest, 'base64').toString('utf8') });
      }
      if (reply.startsWith('ERR ')) return resolve({ ok: false, error: reply.slice(4) });
      resolve({ ok: false, error: `unreadable broker answer: ${reply.slice(0, 80)}` });
    };
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line));
    sock.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) finish(buf);
    });
    sock.on('end', () => finish(buf));
    sock.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail('BROKER_UNREACHABLE', `credential broker at ${broker.socket} is not answering: ${err.code || err.message}`);
    });
  });
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
export async function resolveKey(provider, { env = process.env, keystorePath, fs = fsp, warn, broker = brokerFrom(env), connect } = {}) {
  const envVar = ENV_VARS[provider];
  if (envVar && env[envVar] && String(env[envVar]).trim()) return String(env[envVar]).trim();
  if (broker) {
    let r;
    try {
      r = await brokerRequest(broker, 'GET', provider, undefined, { connect });
    } catch (err) {
      if (typeof warn === 'function') warn(err.message);
      return null;
    }
    if (!r.ok) {
      if (typeof warn === 'function') warn(`credential broker refused GET ${provider}: ${r.error}`);
      return null;
    }
    return typeof r.value === 'string' && r.value.trim() ? r.value.trim() : null;
  }
  const file = keystorePath || defaultKeystorePath(env);
  const { keys, problem } = await readKeystore(file, fs);
  if (problem && typeof warn === 'function') warn(problem);
  const key = keys[provider];
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

// Writes/updates a key: through the broker (the Keychain) when there is one, else in the
// keystore file, creating it with mode 0600. An empty/null key removes it.
export async function setKey(provider, key, { env = process.env, keystorePath, fs = fsp, broker = brokerFrom(env), connect } = {}) {
  if (broker) {
    const r = key ? await brokerRequest(broker, 'SET', provider, key, { connect }) : await brokerRequest(broker, 'DEL', provider, undefined, { connect });
    if (!r.ok) {
      const e = new Error(`credential broker refused ${key ? 'SET' : 'DEL'} ${provider}: ${r.error}`);
      e.code = 'BROKER_REFUSED';
      throw e;
    }
    return;
  }
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

// Human-readable status of where secrets live, for diagnostics (never includes keys).
// With a broker: { broker: true, path: the socket, providers: the names it holds }.
export async function keystoreStatus({ env = process.env, keystorePath, fs = fsp, broker = brokerFrom(env), connect } = {}) {
  if (broker) {
    try {
      const r = await brokerRequest(broker, 'LIST', undefined, undefined, { connect });
      return { path: broker.socket, broker: true, problem: r.ok ? null : `credential broker refused LIST: ${r.error}`, providers: r.ok ? r.names : [] };
    } catch (err) {
      return { path: broker.socket, broker: true, problem: err.message, providers: [] };
    }
  }
  const file = keystorePath || defaultKeystorePath(env);
  const { keys, problem } = await readKeystore(file, fs);
  return { path: file, broker: false, problem, providers: Object.keys(keys).filter((k) => typeof keys[k] === 'string' && keys[k]) };
}
