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
import { isDepartmentKind } from '../../shared/world.js';

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

export async function realpathExisting(p) {
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

// D178: team folders. A department's Rangers share one folder under
// `<workspaceRoot>/_teams/<department>/`, and the rule the owner chose is read shared,
// write own: any team may read any team's folder, and a team may write only its own.
// Knowledge compounds across departments while a mistake stays with whoever made it.
//
// The folder is addressed by an explicit `_teams/<department>/...` prefix rather than by
// `../`, so reaching another team's files is a deliberate act that reads as one, and the
// agent's own workspace keeps working exactly as before for every other path.
export const TEAMS_DIR = '_teams';

// `_teams/<dept>/rest` -> { dept, rest }, or null when the path is not a team path at all.
// Only the literal prefix counts: a file called `_teamsnotes` is an ordinary path.
export function parseTeamPath(input) {
  if (typeof input !== 'string') return null;
  const norm = input.replace(/^[./]+/, '');
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  if (parts[0] !== TEAMS_DIR) return null;
  const dept = parts[1] || '';
  return { dept, rest: parts.slice(2).join('/') };
}

// Resolves a path for an agent, across its own workspace and the team folders.
//
// `write: true` applies the write rule. Every path still ends up proven to sit inside a
// single named root by `resolveInWorkspace`, which is what makes `..` and symlinks safe —
// this function only decides which root, it never relaxes the containment.
export async function resolveForAgent(ctx, input, { write = false } = {}) {
  const team = parseTeamPath(input);
  if (!team) return resolveInWorkspace(ctx.workspaceDir, input);
  if (!ctx.workspaceRoot) throw new SandboxError('team folders are not available here');
  if (!team.dept) throw new SandboxError(`${TEAMS_DIR}/ needs a department: ${TEAMS_DIR}/<department>/<file>`);
  if (!isDepartmentKind(team.dept)) throw new SandboxError(`"${team.dept}" is not a department of the park`);
  if (write && team.dept !== ctx.department) {
    throw new SandboxError(
      ctx.department
        ? `you may read any team's folder but write only your own (${TEAMS_DIR}/${ctx.department}/); ask the ${team.dept} department instead`
        : `you belong to no department, so you may read a team's folder but write to none`,
    );
  }
  // The department's own folder is the root, so a team path can no more escape into
  // another team than an agent path can escape the workspace.
  const root = path.join(ctx.workspaceRoot, TEAMS_DIR, team.dept);
  await fsp.mkdir(root, { recursive: true });
  return resolveInWorkspace(root, team.rest || '.');
}

// What a path reads as in a message back to the agent: team paths keep their prefix so the
// Ranger sees the name it used, not an absolute path on someone's disk.
export function displayPath(ctx, input, resolved) {
  const team = parseTeamPath(input);
  if (team) return `${TEAMS_DIR}/${team.dept}/${team.rest}`;
  return path.relative(ctx.workspaceDirReal || ctx.workspaceDir, resolved);
}

export const fsRead = {
  name: 'fs.read',
  description:
    'Read a UTF-8 text file from your workspace. `path` is relative to the workspace root. ' +
    'To read a department\'s shared folder, use `_teams/<department>/<file>` — you may read any ' +
    'team\'s folder, and write only your own. ' +
    `Output is truncated after ${READ_LIMIT_BYTES} bytes and says so.`,
  inputSchema: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', minLength: 1, description: 'Workspace-relative file path' } },
  },
  confirm: false,
  async run(input, ctx) {
    const file = await resolveForAgent(ctx, input.path);
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
    'To write something your whole department shares, use `_teams/<your department>/<file>`; you ' +
    'cannot write into another department\'s folder — ask that department instead. ' +
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
    const file = await resolveForAgent(ctx, input.path, { write: true });
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Re-check after mkdir so a directory created through a link cannot redirect the write.
    const check = await resolveForAgent(ctx, input.path, { write: true });
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
    return { ok: true, output: `wrote ${bytes} bytes to ${displayPath({ ...ctx, workspaceDirReal: await fsp.realpath(ctx.workspaceDir) }, input.path, file)}` };
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
