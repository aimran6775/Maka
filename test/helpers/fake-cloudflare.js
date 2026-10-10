// A fake Cloudflare DNS API (zones + dns_records) on an ephemeral port. Test-only.
import http from 'node:http';

export async function startFakeCloudflare({ token = 'cf-test-token', zones = [{ id: 'zone1', name: 'makapark.com' }], records = [] } = {}) {
  const state = { zones, records: records.map((r, i) => ({ id: r.id || `rec${i + 1}`, ttl: 1, proxied: false, ...r })), calls: [] };
  let n = state.records.length;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    state.calls.push({ method: req.method, path: url.pathname + url.search, body });
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${token}`) return send(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }], result: null });
    if (req.method === 'GET' && url.pathname === '/zones') return send(200, { success: true, errors: [], result: state.zones.filter((z) => !url.searchParams.get('name') || z.name === url.searchParams.get('name')) });
    const m = /^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, { success: false, errors: [{ message: 'no route' }] });
    if (!state.zones.some((z) => z.id === m[1])) return send(404, { success: false, errors: [{ message: 'zone not found' }] });
    if (req.method === 'GET' && !m[2]) return send(200, { success: true, errors: [], result: state.records.map((r) => ({ ...r, zone_id: m[1] })) });
    if (req.method === 'POST' && !m[2]) {
      if (!body || !body.type || !body.name) return send(400, { success: false, errors: [{ message: 'bad record' }] });
      const rec = { id: `rec${++n}`, ttl: 1, proxied: false, ...body };
      state.records.push(rec);
      return send(200, { success: true, errors: [], result: rec });
    }
    const idx = state.records.findIndex((r) => r.id === m[2]);
    if (idx === -1) return send(404, { success: false, errors: [{ message: 'record not found' }] });
    if (req.method === 'PUT') {
      state.records[idx] = { ...state.records[idx], ...body };
      return send(200, { success: true, errors: [], result: state.records[idx] });
    }
    if (req.method === 'DELETE') {
      const [gone] = state.records.splice(idx, 1);
      return send(200, { success: true, errors: [], result: { id: gone.id } });
    }
    return send(405, { success: false, errors: [{ message: 'method' }] });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    state,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}
