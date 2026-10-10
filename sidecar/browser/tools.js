// The Rangers' browser tools (phase 2 step 13), granted by the Field office fixture and
// all under the browser_control leash (shared/leash.js TOOL_DOMAINS). Each acts through
// toolContext.browser (sidecar/browser/control.js), which traces every step with a
// screenshot and raises a BROWSER HANDOFF when the page asks for a login, a one-time
// code, a captcha or card details.
//
// ctx: { browser, agentId, runId, signal, workspaceDir }

import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { defaultNetGuard } from '../netguard.js';

// Safety H1: a Ranger's browser only opens public URLs (never the sidecar, the LAN or
// loopback); sidecar/browser/control.js checks the page it lands on after every action.
async function guardUrl(ctx, url) {
  const verdict = await (ctx.netGuard || defaultNetGuard()).check(url);
  return verdict.ok ? null : { ok: false, code: 'NET_GUARD', error: verdict.reason };
}

function noBrowser(ctx) {
  return !ctx.browser ? { ok: false, error: 'browser control is not available in this run' } : null;
}

function handoffNote(h) {
  if (!h) return '';
  if (h.repeated) return `\n[handoff ${h.handoffId} was already handed back for this page; the Superintendent left it as it is]`;
  if (h.status === 'returned') return `\n[BROWSER HANDOFF ${h.kind}: the Superintendent completed the step and handed the page back${h.notes ? `: ${h.notes}` : ''}]`;
  return `\n[BROWSER HANDOFF ${h.kind}: ${h.reason}; the run ended before the Superintendent handed the page back]`;
}

async function viaControl(ctx, action, input, run, { checkHandoff = true } = {}) {
  const missing = noBrowser(ctx);
  if (missing) return missing;
  try {
    const out = await ctx.browser.act({ agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, action, input, run, checkHandoff });
    if (out.handoff && out.handoff.status === 'abandoned') return { ok: false, code: 'HANDOFF_ABANDONED', error: `${action} stopped: ${out.handoff.reason}; the run ended before the Superintendent handed the page back` };
    return { ok: true, output: JSON.stringify({ ...(typeof out.result === 'object' && out.result ? out.result : { result: out.result }), url: out.url, title: out.title, screenshot: out.screenshot, handoff: out.handoff ? { id: out.handoff.handoffId, kind: out.handoff.kind, status: out.handoff.status, notes: out.handoff.notes || '' } : null }) + handoffNote(out.handoff) };
  } catch (err) {
    return { ok: false, code: err.code || 'BROWSER', error: err.message };
  }
}

const target = {
  selector: { type: 'string', description: 'A CSS selector for the element' },
  text: { type: 'string', description: 'Visible text, label, placeholder or aria-label of the element (used when no selector is given)' },
};

function describeTarget(input) {
  return input.selector ? `"${input.selector}"` : input.text ? `"${input.text}"` : 'an element';
}

async function insideWorkspace(ctx, p) {
  const abs = path.resolve(ctx.workspaceDir, p);
  const rel = path.relative(await fsp.realpath(ctx.workspaceDir), await fsp.realpath(abs).catch(() => abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error(`${p} is outside the workspace`), { code: 'SANDBOX' });
  return abs;
}

export const browserOpen = {
  name: 'browser.open',
  description: 'Open a URL in your browser (your own profile; logins persist between runs). Returns the page title, URL and the first part of its text. If the page asks for a login, a code, a captcha or a payment, the Superintendent is handed the window and you wait.',
  inputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: { type: 'string', minLength: 1 } } },
  confirm: false,
  summarize: (input) => `open ${input.url} in the browser`,
  async run(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return { ok: false, error: 'browser.open takes an http(s) URL' };
    const refused = await guardUrl(ctx, input.url);
    if (refused) return refused;
    // Opening leaves the current page, so only the page it lands on is checked.
    return viaControl(ctx, 'open', input, async (page) => {
      const s = await page.navigate(input.url);
      const text = await page.text(1500);
      return { ...s, text };
    }, { checkHandoff: { before: false, after: true } });
  },
};

export const browserRead = {
  name: 'browser.read',
  description: 'Read the current page: its visible text and/or accessibility tree (roles and names of links, buttons, fields, headings).',
  inputSchema: { type: 'object', additionalProperties: false, properties: { what: { type: 'string', enum: ['text', 'tree', 'both'] }, maxChars: { type: 'integer', minimum: 200, maximum: 60000 } } },
  confirm: false,
  summarize: () => 'read the current browser page',
  async run(input, ctx) {
    const what = input.what || 'both';
    const max = input.maxChars || 8000;
    return viaControl(ctx, 'read', input, async (page) => {
      const out = {};
      if (what !== 'tree') out.text = await page.text(max);
      if (what !== 'text') {
        const lines = await page.tree(400);
        const joined = lines.join('\n');
        out.tree = joined.length > max ? `${joined.slice(0, max)}\n…[${lines.length} nodes, truncated]` : joined;
      }
      return out;
    }, { checkHandoff: false });
  },
};

export const browserClick = {
  name: 'browser.click',
  description: 'Click an element by CSS selector or by its visible text / label. Waits for any navigation to settle.',
  inputSchema: { type: 'object', additionalProperties: false, properties: target },
  confirm: false,
  summarize: (input) => `click ${describeTarget(input)} in the browser`,
  async run(input, ctx) {
    if (!input.selector && !input.text) return { ok: false, error: 'give a selector or the visible text of what to click' };
    return viaControl(ctx, 'click', input, async (page) => ({ clicked: await page.click(input) }));
  },
};

export const browserType = {
  name: 'browser.type',
  description: 'Type into a field found by CSS selector or by its label / placeholder. Replaces the current value; set submit to press Enter afterwards.',
  inputSchema: { type: 'object', required: ['value'], additionalProperties: false, properties: { ...target, value: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } } },
  confirm: false,
  summarize: (input) => `type ${input.value.length > 40 ? `${input.value.length} characters` : `"${input.value}"`} into ${describeTarget(input)} in the browser${input.submit ? ' and submit' : ''}`,
  async run(input, ctx) {
    if (!input.selector && !input.text) return { ok: false, error: 'give a selector or the label of the field' };
    return viaControl(ctx, 'type', input, async (page) => ({ typed: await page.type(input, input.value, { submit: Boolean(input.submit), clear: input.clear !== false }) }));
  },
};

export const browserUpload = {
  name: 'browser.upload',
  description: 'Attach one or more files from your workspace to a file input (CSS selector).',
  inputSchema: { type: 'object', required: ['selector', 'paths'], additionalProperties: false, properties: { selector: { type: 'string', minLength: 1 }, paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } } } },
  confirm: false,
  summarize: (input) => `upload ${input.paths.join(', ')} through ${describeTarget(input)} in the browser`,
  async run(input, ctx) {
    let files;
    try {
      files = [];
      for (const p of input.paths) {
        const abs = await insideWorkspace(ctx, p);
        await fsp.access(abs);
        files.push(abs);
      }
    } catch (err) {
      return { ok: false, code: err.code === 'SANDBOX' ? 'SANDBOX' : 'NOT_FOUND', error: err.code === 'SANDBOX' ? err.message : `cannot read ${err.path || 'the file'}: ${err.message}` };
    }
    return viaControl(ctx, 'upload', input, async (page) => page.upload(input.selector, files));
  },
};

export const browserDownload = {
  name: 'browser.download',
  description: 'Download a file into downloads/ in your workspace: by URL, or by clicking a link/button found by selector or text.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { url: { type: 'string' }, ...target } },
  confirm: false,
  summarize: (input) => `download ${input.url || describeTarget(input)} with the browser`,
  async run(input, ctx) {
    if (!input.url && !input.selector && !input.text) return { ok: false, error: 'give a url, a selector or the text of the link' };
    if (input.url && !/^https?:\/\//i.test(input.url)) return { ok: false, error: 'browser.download takes an http(s) URL' };
    if (input.url) {
      const refused = await guardUrl(ctx, input.url);
      if (refused) return refused;
    }
    const dir = path.join(ctx.workspaceDir, 'downloads');
    await fsp.mkdir(dir, { recursive: true });
    return viaControl(ctx, 'download', input, async (page) => {
      const d = await page.download(input, dir);
      return { path: path.relative(ctx.workspaceDir, d.path), bytes: d.bytes, from: d.url };
    });
  },
};

export const browserScreenshot = {
  name: 'browser.screenshot',
  description: 'Save a screenshot of the current page into your browser trace and return its path.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  confirm: false,
  summarize: () => 'take a screenshot in the browser',
  async run(input, ctx) {
    return viaControl(ctx, 'screenshot', input, async () => ({}), { checkHandoff: false });
  },
};

export const BROWSER_TOOLS = Object.freeze({
  'browser.open': browserOpen,
  'browser.read': browserRead,
  'browser.click': browserClick,
  'browser.type': browserType,
  'browser.upload': browserUpload,
  'browser.download': browserDownload,
  'browser.screenshot': browserScreenshot,
});
