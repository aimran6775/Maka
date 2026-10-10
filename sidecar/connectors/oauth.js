// OAuth 2 with PKCE for connectors (phase 2 step 14), core modules only.
//
//   pkcePair()                                  -> { verifier, challenge }  (S256)
//   createOAuthFlow({ authorizeUrl, tokenUrl, clientId, clientSecret, scopes, redirectPort,
//                     redirectHost, extraAuthParams, fetch, clock })
//     .start()      -> { authorizeUrl, state, redirectUri }  (listens for the callback)
//     .finished     -> Promise<tokens>  resolves when the browser hits the callback
//     .cancel()
//   refreshTokens({ tokenUrl, clientId, clientSecret, refreshToken, fetch, clock })
//
// The callback server binds 127.0.0.1 only. `redirectPort` must be the port registered
// with the platform (0 for tests). Tokens are { accessToken, refreshToken, expiresAt,
// scope, tokenType }, stored by the registry in the keystore as one JSON string.

import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

export const DEFAULT_OAUTH_PORT = 8765;
export const CALLBACK_PATH = '/callback';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function normalizeTokens(body, now) {
  if (!body || typeof body !== 'object' || !body.access_token) throw fail('BAD_TOKEN_RESPONSE', 'the token endpoint returned no access_token');
  return {
    accessToken: String(body.access_token),
    refreshToken: body.refresh_token ? String(body.refresh_token) : null,
    expiresAt: Number.isFinite(Number(body.expires_in)) ? now + Number(body.expires_in) * 1000 : null,
    scope: body.scope ? String(body.scope) : '',
    tokenType: body.token_type ? String(body.token_type) : 'Bearer',
  };
}

async function postForm(url, params, { fetch: fetchImpl, clientId, clientSecret }) {
  // A confidential client's secret goes both ways platforms accept it: HTTP Basic and the
  // form body (Google reads the body; others read the header).
  const body = new URLSearchParams(clientSecret ? { ...params, client_secret: clientSecret } : params);
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (clientSecret) headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body: body.toString() });
  } catch (err) {
    throw fail('NETWORK', `token endpoint unreachable: ${err.message}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) throw fail(`HTTP_${res.status}`, `token endpoint answered ${res.status}: ${(json && (json.error_description || json.error)) || text.slice(0, 200)}`);
  return json;
}

export async function refreshTokens({ tokenUrl, clientId, clientSecret = null, refreshToken, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() } }) {
  if (!refreshToken) throw fail('NO_REFRESH_TOKEN', 'no refresh token to renew with');
  const json = await postForm(tokenUrl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, { fetch: fetchImpl, clientId, clientSecret });
  const t = normalizeTokens(json, clock.now());
  if (!t.refreshToken) t.refreshToken = refreshToken;
  return t;
}

export function createOAuthFlow({ authorizeUrl, tokenUrl, clientId, clientSecret = null, scopes = [], redirectPort = DEFAULT_OAUTH_PORT, redirectHost = '127.0.0.1', extraAuthParams = {}, fetch: fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, timeoutMs = 10 * 60 * 1000 }) {
  if (!authorizeUrl || !tokenUrl || !clientId) throw new TypeError('createOAuthFlow needs authorizeUrl, tokenUrl and clientId');
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(16));
  let server = null;
  let settled = false;
  let resolveDone;
  let rejectDone;
  const finished = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  finished.catch(() => {});
  let timer = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    if (server) {
      server.closeAllConnections();
      server.close();
      server = null;
    }
  };

  async function handle(req, res) {
    const url = new URL(req.url, `http://${redirectHost}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not the callback');
    }
    const page = (status, text) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Maka</title><body style="font-family:system-ui;padding:2em"><h1>Maka</h1><p>${text}</p><p>You can close this tab.</p></body>`);
    };
    if (settled) return page(410, 'This sign-in was already completed.');
    if (url.searchParams.get('error')) {
      settled = true;
      page(400, `The platform refused: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
      stop();
      return rejectDone(fail('OAUTH_DENIED', url.searchParams.get('error_description') || url.searchParams.get('error')));
    }
    if (url.searchParams.get('state') !== state) return page(400, 'The state does not match this sign-in; start again from Maka.');
    const code = url.searchParams.get('code');
    if (!code) return page(400, 'No code in the callback.');
    settled = true;
    try {
      const json = await postForm(tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: api.redirectUri, client_id: clientId, code_verifier: verifier }, { fetch: fetchImpl, clientId, clientSecret });
      const tokens = normalizeTokens(json, clock.now());
      page(200, 'Connected. Maka has the token now.');
      stop();
      resolveDone(tokens);
    } catch (err) {
      page(502, `The token exchange failed: ${err.message}`);
      stop();
      rejectDone(err);
    }
  }

  const api = {
    state,
    redirectUri: null,
    finished,
    async start() {
      server = http.createServer((req, res) => handle(req, res).catch((err) => { res.writeHead(500); res.end(err.message); }));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(redirectPort, redirectHost, resolve);
      });
      const port = server.address().port;
      api.redirectUri = `http://${redirectHost}:${port}${CALLBACK_PATH}`;
      const u = new URL(authorizeUrl);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', clientId);
      u.searchParams.set('redirect_uri', api.redirectUri);
      if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      for (const [k, v] of Object.entries(extraAuthParams)) u.searchParams.set(k, v);
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stop();
        rejectDone(fail('OAUTH_TIMEOUT', 'the sign-in was not completed in time'));
      }, timeoutMs);
      return { authorizeUrl: u.toString(), state, redirectUri: api.redirectUri, port };
    },
    cancel() {
      if (settled) return;
      settled = true;
      stop();
      rejectDone(fail('OAUTH_CANCELLED', 'the sign-in was cancelled'));
    },
  };
  return api;
}
