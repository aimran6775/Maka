// Tool names on the wire (D169).
//
// Maka names its tools with dots — `fs.write`, `plan.submit`, `mcp.files.read_file` —
// because the dot says which kit a tool belongs to, and the leash, the Gate and every
// event key off that name. Both provider APIs refuse it: Anthropic requires tool names to
// match ^[a-zA-Z0-9_-]{1,128}$ and OpenAI the same within 64 characters, so every real
// call carrying tools was rejected with HTTP 400 before a single token was generated.
// The fakes under test/helpers accepted anything, which is why the suite never saw it.
//
// So the park keeps its names and the wire gets safe ones: this module maps each way for
// one request. Pure, no network, no state between requests.

export const MAX_TOOL_NAME = 64; // the stricter of the two APIs

// One name, made safe: anything outside the allowed set becomes an underscore.
export function safeToolName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, MAX_TOOL_NAME) || 'tool';
}

// A two-way map for one request's tool list. Two different tools can sanitise to the same
// name (`a.b` and `a_b`), so later collisions take a numbered suffix; the order of the
// tool list decides, which makes the mapping deterministic for the same list.
export function toolNameMap(tools) {
  const toApi = new Map();
  const fromApi = new Map();
  for (const t of tools || []) {
    const original = t && t.name;
    if (!original || toApi.has(original)) continue;
    let safe = safeToolName(original);
    if (fromApi.has(safe)) {
      let n = 2;
      let candidate = `${safe.slice(0, MAX_TOOL_NAME - 2)}_${n}`;
      while (fromApi.has(candidate)) {
        n += 1;
        candidate = `${safe.slice(0, MAX_TOOL_NAME - String(n).length - 1)}_${n}`;
      }
      safe = candidate;
    }
    toApi.set(original, safe);
    fromApi.set(safe, original);
  }
  return {
    toApi: (name) => toApi.get(name) ?? safeToolName(name),
    // A name the model sent back. Unknown names pass through untouched so a provider
    // inventing one surfaces as "unknown tool" from the gate rather than silently
    // becoming some other tool.
    fromApi: (name) => fromApi.get(name) ?? name,
    size: toApi.size,
  };
}
