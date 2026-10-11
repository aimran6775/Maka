#!/usr/bin/env node
// Headless park bench (manual, not part of test:fast; phase 4 step 15): boots a test sidecar
// with no provider, fills a dense park (foliage at `--density`, a crew of `--crew` Rangers
// across bench camps), opens the page in headless Chromium once per configuration and
// reports the measured frame times from `park.frameStats()`: median and p95 time between
// frames, the work inside a frame, draw calls, triangles and the LOD buckets. Every run is
// done with LOD on and LOD off at the same density, so the gain is measured, not claimed.
//
//   node scripts/park-bench.mjs [--density=3] [--crew=24] [--frames=120] [--seconds=45] [--webgpu] [--json]
//   --webgpu   also runs the WebGPU path (Chromium gets a software WebGPU adapter)
//   CHROMIUM=/path/to/chromium   the binary (default: /opt/pw-browsers/chromium or PATH)
//
// Headless Chromium renders with SwiftShader, a software rasteriser: the numbers compare
// configurations with each other and are no claim about a GPU. On the Mac, the same
// statistics show in the park's overlay (`?dev=1` or the backtick key) and the runbook
// records what to read there.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../test/helpers/test-server.js';
import { BASE_FLAGS, WEBGPU_FLAGS, launchChromium, connectCdp, openPage, stopChromium, removeWithRetry, wait } from './lib/headless-chromium.mjs';

export const DEFAULTS = Object.freeze({ density: 3, crew: 24, frames: 120, seconds: 45, webgpu: false, json: false });
// The department camps the bench's crew stands in (shared/world.js ZONE_KINDS), in order.
export const CAMP_KINDS = Object.freeze(['research', 'marketing', 'sales', 'finance', 'operations_support', 'product_listings']);

// `--key=value` and `--flag` into options; unknown keys are refused so a typo cannot pass.
export function parseArgs(argv, defaults = DEFAULTS) {
  const out = { ...defaults };
  for (const arg of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m || !(m[1] in defaults)) throw new Error(`unknown option ${arg}; known: ${Object.keys(defaults).map((k) => `--${k}`).join(' ')}`);
    const [, key, raw] = m;
    if (typeof defaults[key] === 'boolean') out[key] = raw === undefined ? true : raw !== 'false' && raw !== '0';
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} needs a positive number`);
      out[key] = n;
    }
  }
  return out;
}

// The configurations a run measures, in order.
export function configurations({ webgpu }) {
  const renderers = webgpu ? ['webgl2', 'webgpu'] : ['webgl2'];
  const out = [];
  for (const renderer of renderers) for (const lod of ['on', 'off']) out.push({ renderer, lod });
  return out;
}

const ms = (v) => (v === null || v === undefined ? 'no data' : `${v.toFixed(1)} ms`);
const num = (v) => (v === null || v === undefined ? 'no data' : String(v));

// A plain table of the rows a run produced; a row with no frames says so.
export function benchTable(rows) {
  const head = ['config', 'renderer (as run)', 'frames', 'frame median', 'frame p95', 'work median', 'draw calls', 'triangles', 'foliage near/far/culled', 'crew near/mid/far'];
  const body = rows.map((r) => {
    const s = r.stats;
    if (!s || !s.frameMs || !s.frameMs.samples) return [`${r.renderer} lod ${r.lod}`, r.rendererLabel || 'no data', '0', 'no data', 'no data', 'no data', 'no data', 'no data', 'no data', 'no data'];
    return [`${r.renderer} lod ${r.lod}`, s.renderer, String(s.frameMs.samples), ms(s.frameMs.median), ms(s.frameMs.p95), ms(s.workMs.median), num(s.calls), num(s.triangles), s.lod.foliage.join('/'), s.lod.crew.join('/')];
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)];
}

// The gain of LOD on over LOD off for one renderer, from medians; null without both.
export function lodGain(rows, renderer) {
  const on = rows.find((r) => r.renderer === renderer && r.lod === 'on');
  const off = rows.find((r) => r.renderer === renderer && r.lod === 'off');
  const med = (r) => (r && r.stats && r.stats.frameMs && r.stats.frameMs.samples ? r.stats.frameMs.median : null);
  if (med(on) === null || med(off) === null) return null;
  return { onMs: med(on), offMs: med(off), ratio: med(off) / med(on) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const srv = await startTestServer({ makeProvider: async () => { throw new Error('the bench runs no model'); } });
  // A dense crew: Rangers across department camps, one tile each (the layout decides the tiles).
  const camps = Math.max(1, Math.ceil(opts.crew / 20));
  let made = 0;
  for (let c = 0; c < camps && made < opts.crew; c++) {
    const zone = await srv.agents.ensureZone(CAMP_KINDS[c % CAMP_KINDS.length], { id: `bench-camp-${c + 1}`, name: `Bench camp ${c + 1}`, size: { w: 10, h: 6 } });
    for (let i = 0; i < 20 && made < opts.crew; i++) {
      try {
        await srv.agents.create({ name: `Bench ${made + 1}`, role: 'ranger', zoneId: zone.id });
        made++;
      } catch (err) {
        if (err.code !== 'CONFLICT') throw err;
        break;
      }
    }
  }
  const wanted = srv.layoutState.get().agents.length;
  const { chrome, wsUrl, profile } = await launchChromium({ flags: BASE_FLAGS, extraFlags: opts.webgpu ? WEBGPU_FLAGS : [] });
  const cdp = await connectCdp(wsUrl);
  const rows = [];
  for (const cfg of configurations(opts)) {
    const page = await openPage(cdp, `${srv.url}/?renderer=${cfg.renderer}&lod=${cfg.lod}&density=${opts.density}`);
    const row = { ...cfg, stats: null, rendererLabel: null, errors: [] };
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        ready = await page.evaluate(`(() => { const p = window.maka && window.maka.park(); if (!p) return false; const st = p.status; return (st.ranger === 'ready' || st.ranger.startsWith('static')) && st.assets !== 'loading' && p.bodies().length >= ${wanted}; })()`);
        if (!ready) await wait(500);
      }
      row.rendererLabel = await page.evaluate('window.maka && window.maka.park() ? window.maka.park().status.renderer : null');
      if (!ready) throw new Error(`the park did not get ready (${wanted} bodies, assets, ranger) in 60 s`);
      await page.evaluate('window.maka.park().resetFrameStats()');
      const until = Date.now() + opts.seconds * 1000;
      let frames = 0;
      while (frames < opts.frames && Date.now() < until) {
        await wait(500);
        frames = await page.evaluate('window.maka.park().frameStats().frames');
      }
      row.stats = JSON.parse(await page.evaluate('JSON.stringify(window.maka.park().frameStats())'));
    } catch (err) {
      row.errors.push(err.message);
    }
    row.errors.push(...page.errors);
    rows.push(row);
    await page.close();
  }
  cdp.close();
  await stopChromium(chrome);
  await srv.close();
  await removeWithRetry(profile);
  if (opts.json) {
    console.log(JSON.stringify({ options: opts, agents: wanted, rows }, null, 2));
  } else {
    console.log(`park bench: density ×${opts.density}, ${wanted} bodies, up to ${opts.frames} frames or ${opts.seconds} s per configuration, software GL in headless Chromium (relative numbers)`);
    for (const l of benchTable(rows)) console.log(l);
    for (const renderer of [...new Set(rows.map((r) => r.renderer))]) {
      const g = lodGain(rows, renderer);
      console.log(g ? `${renderer}: LOD on ${ms(g.onMs)} vs off ${ms(g.offMs)} median between frames (×${g.ratio.toFixed(2)})` : `${renderer}: no LOD comparison (a run has no frames)`);
    }
    for (const r of rows) if (r.errors.length) console.log(`${r.renderer} lod ${r.lod} errors:`, r.errors.slice(0, 3));
  }
  const failed = rows.some((r) => r.errors.length || !r.stats);
  console.log(failed ? 'PARK BENCH FAILED' : 'PARK BENCH OK');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
