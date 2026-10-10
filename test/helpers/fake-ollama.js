// A fake Ollama server on an ephemeral port: /api/tags (models with sizes and details),
// /api/version, /api/pull (streamed NDJSON progress, `failPull` to make it error mid-way),
// /api/delete. Records every call. Test-only.
import http from 'node:http';

export async function startFakeOllama({ models = [], version = '0.6.0', pullSteps = null } = {}) {
  const state = { models: [...models], calls: [], failPull: null, pulls: [] };
  const steps = pullSteps || [
    { status: 'pulling manifest' },
    { status: 'pulling abc', digest: 'sha256:abc', total: 4000, completed: 1000 },
    { status: 'pulling abc', digest: 'sha256:abc', total: 4000, completed: 4000 },
    { status: 'verifying sha256 digest' },
    { status: 'writing manifest' },
    { status: 'success' },
  ];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({ method: req.method, path: req.url, body });
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/tags') return json(200, { models: state.models.map((m) => ({ name: m.name, model: m.name, size: m.size || 0, modified_at: '2026-10-10T00:00:00Z', details: { family: m.family || 'qwen2', parameter_size: m.parameters || '7.6B', quantization_level: m.quant || 'Q4_K_M' } })) });
    if (req.url === '/api/version') return json(200, { version });
    if (req.url === '/api/pull' && req.method === 'POST') {
      state.pulls.push(body.model);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let i = 0;
      const tick = () => {
        if (state.failPull && i === 2) {
          res.end(JSON.stringify({ error: state.failPull }) + '\n');
          return;
        }
        if (i >= steps.length) {
          state.models.push({ name: body.model, size: 4000 });
          res.end();
          return;
        }
        res.write(JSON.stringify(steps[i++]) + '\n');
        setTimeout(tick, 5);
      };
      tick();
      return;
    }
    if (req.url === '/api/delete' && req.method === 'DELETE') {
      const before = state.models.length;
      state.models = state.models.filter((m) => m.name !== body.model);
      return json(before === state.models.length ? 404 : 200, {});
    }
    json(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); };
  return state;
}
