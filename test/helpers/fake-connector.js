// A fake platform API for the connector framework tests: bearer-key auth on /items, an
// OAuth token endpoint that checks PKCE (the authorize step is simulated by the test
// hitting Maka's callback with the code this fake hands out) and refresh grants.
// Test-only.
import http from 'node:http';
import { createHash } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startFakeConnector({ apiKey = 'sk_test_fake', clientId = 'app-1', clientSecret = null, items = [{ id: 'i1', amount: 500 }], accessTokenTtl = 3600 } = {}) {
  const state = { calls: [], items: [...items], codes: new Map(), tokens: new Map(), refreshes: 0, fail: null };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const ctype = req.headers['content-type'] || '';
    const body = !raw ? null : ctype.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    state.calls.push({ method: req.method, path: url.pathname + url.search, body, headers: req.headers });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      if (body.grant_type === 'authorization_code') {
        const c = state.codes.get(body.code);
        if (!c) return send(400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (c.redirectUri !== body.redirect_uri) return send(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (b64url(createHash('sha256').update(body.code_verifier || '').digest()) !== c.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        if (clientSecret && req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`) return send(401, { error: 'invalid_client' });
        state.codes.delete(body.code);
        const access = `at_${state.tokens.size + 1}`;
        state.tokens.set(access, { refresh: `rt_${state.tokens.size + 1}` });
        return send(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: accessTokenTtl, token_type: 'Bearer', scope: c.scope });
      }
      if (body.grant_type === 'refresh_token') {
        const entry = [...state.tokens.entries()].find(([, t]) => t.refresh === body.refresh_token);
        if (!entry) return send(400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
        state.refreshes += 1;
        const access = `at_${state.tokens.size + 1}`;
        state.tokens.set(access, { refresh: `rt_${state.tokens.size + 1}` });
        return send(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: accessTokenTtl, token_type: 'Bearer' });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (state.fail) return send(state.fail.status || 500, { error: state.fail.message || 'down' });
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (bearer !== apiKey && !state.tokens.has(bearer)) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && url.pathname === '/items') return send(200, { data: state.items });
    if (req.method === 'POST' && url.pathname === '/items') {
      const it = { id: `i${state.items.length + 1}`, ...body };
      state.items.push(it);
      return send(201, it);
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    apiKey,
    clientId,
    state,
    // What the platform's authorize page would do: records the challenge, mints a code.
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const code = `code_${state.codes.size + 1}`;
      state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope') || '' });
      return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), method: u.searchParams.get('code_challenge_method'), clientId: u.searchParams.get('client_id') };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A connector spec against the fake, for registry tests.
export function fakeSpec({ kind = 'fakeshop', label = 'Fake Shop', auth = 'api_key', baseUrl, envVar = 'FAKESHOP_API_KEY', syncEveryMs = 60_000, oauthPort = 0, clientSecretKey = null } = {}) {
  return {
    kind,
    label,
    auth,
    envVar,
    keyName: kind,
    zoneKind: 'sales',
    syncEveryMs,
    oauth: auth === 'oauth2' ? { authorizeUrl: `${baseUrl}/oauth/authorize`, tokenUrl: `${baseUrl}/oauth/token`, clientIdKey: `${kind}ClientId`, clientSecretKey, scopes: ['read_items', 'write_items'] } : undefined,
    emptyData: () => ({ items: [] }),
    summarize: (data) => `${(data.items || []).length} item(s)`,
    makeClient: ({ token, fetch: fetchImpl }) => ({
      async items() {
        const res = await fetchImpl(`${baseUrl}/items`, { headers: { authorization: `Bearer ${token.accessToken}` } });
        if (!res.ok) { const e = new Error(`fake shop answered ${res.status}`); e.code = `HTTP_${res.status}`; throw e; }
        return (await res.json()).data;
      },
      async create(item) {
        const res = await fetchImpl(`${baseUrl}/items`, { method: 'POST', headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(item) });
        if (!res.ok) { const e = new Error(`fake shop answered ${res.status}`); e.code = `HTTP_${res.status}`; throw e; }
        return res.json();
      },
    }),
    async sync({ client, data }) {
      const items = await client.items();
      const known = new Set((data.items || []).map((i) => i.id));
      return { data: { ...data, items }, counts: { items: items.length, new: items.filter((i) => !known.has(i.id)).length } };
    },
    tools: {},
  };
}
