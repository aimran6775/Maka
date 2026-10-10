// Parses a text/event-stream body (a web ReadableStream of bytes, or any async iterable of
// Uint8Array / string) into { event, data } records. Comment lines (": ...") are skipped.
// Multi-line data fields are joined with "\n" per the SSE spec.

export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = null;
  let data = [];

  const flush = function* () {
    if (data.length === 0 && event === null) return;
    yield { event, data: data.join('\n') };
    event = null;
    data = [];
  };

  for await (const chunk of iterate(body)) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        yield* flush();
      } else if (line.startsWith(':')) {
        // comment / keep-alive
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
  if (buffer.length) {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  yield* flush();
}

async function* iterate(body) {
  if (body == null) return;
  if (typeof body === 'string') {
    yield body;
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for await (const chunk of body) yield chunk;
}

// Reads a non-2xx response body for an error message without throwing on bad JSON.
export async function errorFromResponse(res, providerName) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let message = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text);
    message = parsed?.error?.message || parsed?.message || message;
  } catch {
    /* not JSON */
  }
  const err = new Error(`${providerName} HTTP ${res.status}${message ? `: ${message}` : ''}`);
  err.code = `HTTP_${res.status}`;
  err.status = res.status;
  return err;
}
