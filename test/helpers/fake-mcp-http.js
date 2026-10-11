// A fake MCP server over streamable HTTP: POST /mcp takes one JSON-RPC message and answers
// in JSON or, when `sse` is on, as a text/event-stream carrying the response; initialize
// hands out an Mcp-Session-Id that every later request must carry (404 otherwise); with
// `oauth` on, requests without a bearer answer 401 + WWW-Authenticate, the origin serves
// /.well-known/oauth-authorization-server, dynamic client registration, an authorize step
// the test plays (`authorize(url)`) and a token endpoint that checks PKCE. Test-only.
import http from 'node:http';
import { createHash } from 'node:crypto';

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startFakeMcpHttp({ sse = false, oauth = false, tokenTtl = 3600 } = {}) {
  const state = { calls: [], sessions: new Set(), sse, oauth, clients: new Map(), codes: new Map(), tokens: new Map(), registrations: 0, fail: null };
  const TOOLS = [
    { name: 'search', description: 'Searches the knowledge base.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
    { name: 'create_page', description: 'Creates a page.', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    state.calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw ? (() => { try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); } })() : null, bearer });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      if (!oauth) return json(404, { error: 'not found' });
      return json(200, { issuer: api.url, authorization_endpoint: `${api.url}/oauth/authorize`, token_endpoint: `${api.url}/oauth/token`, registration_endpoint: `${api.url}/oauth/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname === '/oauth/register' && req.method === 'POST') {
      const body = JSON.parse(raw);
      state.registrations += 1;
      const id = `dyn-client-${state.registrations}`;
      state.clients.set(id, { redirectUris: body.redirect_uris || [] });
      return json(201, { client_id: id, client_name: body.client_name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(raw));
      if (body.grant_type === 'authorization_code') {
        const c = state.codes.get(body.code);
        if (!c) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (c.redirectUri !== body.redirect_uri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (b64url(createHash('sha256').update(body.code_verifier || '').digest()) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE failed' });
        if (!state.clients.has(body.client_id) && body.client_id !== 'preset-client') return json(400, { error: 'invalid_client' });
        state.codes.delete(body.code);
        const access = `mcp-at-${state.tokens.size + 1}`;
        state.tokens.set(access, { refresh: `mcp-rt-${state.tokens.size + 1}`, resource: c.resource });
        return json(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: tokenTtl, token_type: 'Bearer', scope: c.scope });
      }
      if (body.grant_type === 'refresh_token') {
        const entry = [...state.tokens.entries()].find(([, t]) => t.refresh === body.refresh_token);
        if (!entry) return json(400, { error: 'invalid_grant' });
        const access = `mcp-at-${state.tokens.size + 1}`;
        state.tokens.set(access, { refresh: `mcp-rt-${state.tokens.size + 1}` });
        return json(200, { access_token: access, refresh_token: state.tokens.get(access).refresh, expires_in: tokenTtl, token_type: 'Bearer' });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname !== '/mcp' || req.method !== 'POST') return json(404, { error: 'not found' });
    if (state.fail) return json(state.fail.status || 500, { error: state.fail.message || 'down' });
    if (oauth && !(bearer && state.tokens.has(bearer))) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${api.url}/.well-known/oauth-protected-resource"` });
      return res.end();
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return json(400, { error: 'bad json' });
    }
    const sid = req.headers['mcp-session-id'];
    if (msg.method !== 'initialize' && (!sid || !state.sessions.has(sid))) return json(404, { error: 'unknown session' });
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    const answer = (result, error) => {
      const body = error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result };
      const headers = {};
      if (msg.method === 'initialize') {
        const s = `sess-${state.sessions.size + 1}`;
        state.sessions.add(s);
        headers['mcp-session-id'] = s;
      }
      if (state.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return res.end();
      }
      json(200, body, headers);
    };
    switch (msg.method) {
      case 'initialize':
        return answer({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-http-mcp', version: '1.0' } });
      case 'tools/list':
        return answer({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params;
        if (name === 'search') return answer({ content: [{ type: 'text', text: `results for ${args.q}` }] });
        if (name === 'create_page') return answer({ content: [{ type: 'text', text: `created ${args.title}` }] });
        return answer(null, { code: -32602, message: `unknown tool ${name}` });
      }
      case 'ping':
        return answer({});
      default:
        return answer(null, { code: -32601, message: 'method not found' });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const api = {
    url: `http://127.0.0.1:${server.address().port}`,
    mcpUrl: `http://127.0.0.1:${server.address().port}/mcp`,
    state,
    // The authorize page: records the challenge, mints a code for the callback.
    authorize(authorizeUrl) {
      const u = new URL(authorizeUrl);
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), redirectUri: u.searchParams.get('redirect_uri'), scope: u.searchParams.get('scope') || '', resource: u.searchParams.get('resource') });
      return { code, state: u.searchParams.get('state'), redirectUri: u.searchParams.get('redirect_uri'), clientId: u.searchParams.get('client_id'), resource: u.searchParams.get('resource') };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}
