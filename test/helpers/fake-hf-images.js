// A fake Hugging Face Inference text-to-image endpoint: POST /models/<owner>/<model> with
// the bearer HF_TOKEN answers PNG bytes (a tiny valid PNG), records every prompt, and can be
// told to answer 401, 503 (model loading), 500 or a non-image body. Test-only.
import http from 'node:http';

// A 1×1 transparent PNG.
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function startFakeHfImages({ token = 'hf-test-token' } = {}) {
  const state = { calls: [], fail: null, body: null, contentType: 'image/png' };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsed: raw };
    }
    const m = /^\/models\/(.+)$/.exec(req.url);
    state.calls.push({ method: req.method, path: req.url, model: m ? m[1] : null, headers: req.headers, body });
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(Buffer.isBuffer(data) ? data : typeof data === 'string' ? data : JSON.stringify(data));
    };
    if (!m || req.method !== 'POST') return send(404, { error: 'Not Found' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Invalid credentials in Authorization header' });
    if (state.fail) {
      const f = state.fail;
      if (f.status === 503) return send(503, { error: `Model ${m[1]} is currently loading`, estimated_time: f.estimatedTime || 20 });
      return send(f.status || 500, { error: f.message || 'Internal Server Error' });
    }
    if (!body || typeof body.inputs !== 'string') return send(400, { error: 'inputs is required' });
    return send(200, state.body || TINY_PNG, state.contentType);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    baseUrl: `${url}/models`,
    token,
    state,
    prompts: () => state.calls.filter((c) => c.body && c.body.inputs).map((c) => c.body.inputs),
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
