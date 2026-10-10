// The phase 1 tool registry: fs.read, fs.write (sandboxed to the agent workspace) and
// web.fetch. Each tool is { name, description, inputSchema, confirm, run(input, ctx) }.
//
// ctx: { workspaceDir, fetch, signal, runId, agentId }
// run() returns { ok: true, output: string } or { ok: false, error: string }.
//
// Sandbox rules for fs.*: the path is resolved against the workspace; the real path of
// the file (read) or of its parent directory (write) must stay inside the real path of
// the workspace, so `..` and symlinks cannot escape. Sizes are capped to keep transcripts
// sane and the model's context honest about truncation.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { validate } from '../../shared/schema.js';
import { guardedFetch, defaultNetGuard } from '../netguard.js';

export const READ_LIMIT_BYTES = 200 * 1024;
export const WRITE_LIMIT_BYTES = 1024 * 1024;
export const FETCH_LIMIT_BYTES = 500 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;

class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SANDBOX';
  }
}

async function realpathExisting(p) {
  // Real path of the deepest existing ancestor of p, plus the remaining relative tail.
  let cur = p;
  const tail = [];
  while (true) {
    try {
      const real = await fsp.realpath(cur);
      return path.join(real, ...tail.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function inside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolves `input` to an absolute path proven to live inside workspaceDir.
export async function resolveInWorkspace(workspaceDir, input) {
  if (typeof input !== 'string' || !input.trim()) throw new SandboxError('path is required');
  if (input.includes('\0')) throw new SandboxError('path contains a NUL byte');
  const root = await fsp.realpath(workspaceDir);
  const candidate = path.resolve(root, input);
  if (!inside(root, candidate)) throw new SandboxError(`path escapes the workspace: ${input}`);
  const real = await realpathExisting(candidate);
  if (!inside(root, real)) throw new SandboxError(`path escapes the workspace via a link: ${input}`);
  return real;
}

export const fsRead = {
  name: 'fs.read',
  description:
    'Read a UTF-8 text file from your workspace. `path` is relative to the workspace root. ' +
    `Output is truncated after ${READ_LIMIT_BYTES} bytes and says so.`,
  inputSchema: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', minLength: 1, description: 'Workspace-relative file path' } },
  },
  confirm: false,
  async run(input, ctx) {
    const file = await resolveInWorkspace(ctx.workspaceDir, input.path);
    const handle = await fsp.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return { ok: false, error: `${input.path} is not a regular file` };
      const buf = Buffer.alloc(Math.min(stat.size, READ_LIMIT_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      let text = buf.subarray(0, bytesRead).toString('utf8');
      if (stat.size > READ_LIMIT_BYTES) text += `\n[truncated: showing ${READ_LIMIT_BYTES} of ${stat.size} bytes]`;
      return { ok: true, output: text };
    } finally {
      await handle.close();
    }
  },
};

export const fsWrite = {
  name: 'fs.write',
  description:
    'Write a UTF-8 text file in your workspace, creating parent directories. `path` is relative ' +
    'to the workspace root. Finished deliverables go under `outbox/`. Overwrites an existing file. ' +
    `Content is limited to ${WRITE_LIMIT_BYTES} bytes.`,
  inputSchema: {
    type: 'object',
    required: ['path', 'content'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, description: 'Workspace-relative file path' },
      content: { type: 'string', description: 'Full file content' },
    },
  },
  confirm: true,
  async run(input, ctx) {
    const bytes = Buffer.byteLength(input.content, 'utf8');
    if (bytes > WRITE_LIMIT_BYTES) return { ok: false, error: `content is ${bytes} bytes; limit is ${WRITE_LIMIT_BYTES}` };
    const file = await resolveInWorkspace(ctx.workspaceDir, input.path);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Re-check after mkdir so a directory created through a link cannot redirect the write.
    const check = await resolveInWorkspace(ctx.workspaceDir, input.path);
    if (check !== file) return { ok: false, error: 'path changed while writing' };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(input.content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
    return { ok: true, output: `wrote ${bytes} bytes to ${path.relative(await fsp.realpath(ctx.workspaceDir), file)}` };
  },
};

// Light HTML-to-text so a fetched page does not flood the transcript with markup.
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|pre|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetch = {
  name: 'web.fetch',
  description:
    'Fetch a public http(s) URL with GET and return its text. HTML is reduced to readable text. ' +
    `Output is truncated after ${FETCH_LIMIT_BYTES} bytes and says so.`,
  inputSchema: {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: { url: { type: 'string', minLength: 1, description: 'Absolute http or https URL' } },
  },
  confirm: false,
  async run(input, ctx) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      return { ok: false, error: `not a valid URL: ${input.url}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, error: `only http and https are allowed, got ${url.protocol}` };
    // Safety H1: only the public internet, checked after DNS and on every redirect hop.
    const guard = ctx.netGuard || defaultNetGuard();
    const verdict = await guard.check(url);
    if (!verdict.ok) return { ok: false, code: 'NET_GUARD', error: verdict.reason };
    const fetchImpl = ctx.fetch || globalThis.fetch;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (ctx.signal) {
      if (ctx.signal.aborted) return { ok: false, error: 'cancelled' };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ac.abort(), ctx.fetchTimeoutMs || FETCH_TIMEOUT_MS);
    try {
      const res = await guardedFetch(url.toString(), { method: 'GET', signal: ac.signal, headers: { 'user-agent': 'Maka/0.1 (+local agent harness)', accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.5' } }, { fetch: fetchImpl, guard });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const raw = Buffer.from(await res.arrayBuffer());
      let text = raw.subarray(0, FETCH_LIMIT_BYTES).toString('utf8');
      if (type.includes('text/html')) text = htmlToText(text);
      if (raw.length > FETCH_LIMIT_BYTES) text += `\n[truncated: showing ${FETCH_LIMIT_BYTES} of ${raw.length} bytes]`;
      const head = `HTTP ${res.status} ${type || 'unknown content-type'}\n\n`;
      return res.ok ? { ok: true, output: head + text } : { ok: false, error: head + text.slice(0, 2000) };
    } catch (err) {
      if (ac.signal.aborted && ctx.signal && ctx.signal.aborted) return { ok: false, error: 'cancelled' };
      if (ac.signal.aborted) return { ok: false, error: `fetch timed out after ${ctx.fetchTimeoutMs || FETCH_TIMEOUT_MS} ms` };
      if (err && (err.code === 'NET_GUARD' || err.code === 'TOO_MANY_REDIRECTS' || err.code === 'BAD_REDIRECT')) return { ok: false, code: err.code, error: err.message };
      return { ok: false, error: `fetch failed: ${err && err.message ? err.message : err}` };
    } finally {
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
    }
  },
};

export const TOOLS = Object.freeze({ 'fs.read': fsRead, 'fs.write': fsWrite, 'web.fetch': webFetch });
export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

// Validates input against the tool's schema; returns an error string or null.
export function inputProblem(tool, input) {
  const r = validate(tool.inputSchema, input);
  if (r.ok) return null;
  return r.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}
