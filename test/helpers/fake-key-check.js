// A fake provider endpoint for key verification: answers 200 for the valid key, 401 for
// any other, 500 when `fail` is set. Test-only.
import http from 'node:http';

export async function startFakeKeyCheck({ valid = 'sk-good' } = {}) {
  const state = { calls: [], fail: false };
  const server = http.createServer((req, res) => {
    state.calls.push({ path: req.url, headers: req.headers });
    const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (state.fail) {
      res.writeHead(500);
      return res.end('boom');
    }
    res.writeHead(key === valid ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(key === valid ? { data: [] } : { error: 'invalid key' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.urls = { anthropic: `${state.url}/v1/models`, openrouter: `${state.url}/api/v1/auth/key` };
  state.close = () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); };
  return state;
}
