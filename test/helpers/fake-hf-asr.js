// A fake Hugging Face automatic-speech-recognition endpoint (phase 4 step 14):
// `POST /models/<owner>/<model>` with the bearer and an audio content type answers
// `{ text }`; records every call's size and type (never the bytes beyond their length);
// `fail` switches to 401 / 503 / 500 answers; `text` sets what it "hears". Test-only.
import http from 'node:http';

export async function startFakeHfAsr({ token = 'hf-test-token', text = 'what did the scout find this week' } = {}) {
  const state = { calls: [], fail: null, text, body: null };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const m = /^\/models\/([^/]+\/[^/?]+)/.exec(req.url);
    if (!m || req.method !== 'POST') return send(404, { error: 'Not Found' });
    state.calls.push({ model: m[1], bytes: raw.length, contentType: req.headers['content-type'] || '', authorization: req.headers.authorization || '' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Invalid credentials in Authorization header' });
    if (state.fail === 401) return send(401, { error: 'Invalid credentials in Authorization header' });
    if (state.fail === 503) return send(503, { error: 'Model openai/whisper-large-v3 is currently loading', estimated_time: 20 });
    if (state.fail) return send(500, { error: 'boom' });
    if (state.body !== null) return send(200, state.body, 'text/plain');
    if (!raw.length) return send(400, { error: 'no audio' });
    return send(200, { text: state.text });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, baseUrl: `${url}/models`, token, state, async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
