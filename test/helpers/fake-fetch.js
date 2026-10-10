// A fetch stand-in that returns a Response whose body streams the given SSE text in
// chunks (so parsers are exercised across boundaries). Records every request.

export function sseResponse(text, { status = 200, chunkSize = 7 } = {}) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

export function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (init && init.signal && init.signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return responder(calls.length - 1, { url, init, body });
  };
  fn.calls = calls;
  return fn;
}

// Builds SSE text from [event, dataObject] pairs (event may be null for data-only streams).
export function sse(records) {
  return records
    .map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    .join('');
}
