#!/usr/bin/env node
// Headless park check (manual, not part of test:fast): boots a test sidecar with a scripted
// provider, opens the park in headless Chromium over the DevTools protocol (core modules
// only: child_process + the global WebSocket), briefs the Chief so a plan, hires and a
// delegation happen, and reports what the page says: renderer status, bodies in the scene,
// console errors. Exit code 1 on page errors or a missing renderer.
//
//   CHROMIUM=/path/to/chromium node scripts/park-check.mjs [--webgpu]
//   PARK_CHECK_SHOT=/tmp/first-run.png  also saves a screenshot of the first-run card
//   (default: /opt/pw-browsers/chromium or `chromium` on PATH)
// The Chromium plumbing lives in scripts/lib/headless-chromium.mjs (shared with park:bench).

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestServer } from '../test/helpers/test-server.js';
import { fakeProvider, text, toolCall, end } from '../test/helpers/fake-provider.js';
import { startFakeOllama } from '../test/helpers/fake-ollama.js';
import { BASE_FLAGS, WEBGPU_FLAGS, launchChromium, connectCdp, openPage, stopChromium, removeWithRetry, wait } from './lib/headless-chromium.mjs';

export { removeWithRetry };

// Phase 4 step 15: `--webgpu` launches Chromium with a software WebGPU adapter so the
// WebGPU path (TSL water, SkyMesh, node materials) runs here too; the check then requires
// the status line to say `webgpu`. Without it the WebGL2 path runs and must say `webgl2`.
const WANT_WEBGPU = process.argv.includes('--webgpu');

const PLAN = { summary: 'One venture: lanterns.', ventures: [{ id: 'lantern-co', name: 'Lantern Co', summary: 'Paper lanterns on Etsy.', budgetUsd: 2, roles: [{ specialty: 'scout' }], tasks: [{ id: 't1', title: 'Research', specialty: 'scout', brief: 'Find five shops.', budgetUsd: 1 }] }] };

// Polls `fn` until it answers something truthy or the deadline passes; answers what it
// last saw either way, so the caller reports a real state and never a sleep's guess.
async function until(fn, ms, step = 250) {
  const end = Date.now() + ms;
  let last = await fn();
  while (!last && Date.now() < end) {
    await wait(step);
    last = await fn();
  }
  return last;
}

async function main() {
  const chiefProvider = fakeProvider([
    [...toolCall('p1', 'plan.submit', PLAN), end('tool_use', { inputTokens: 100, outputTokens: 20 })],
    [...toolCall('h1', 'crew.hire', { name: 'Ada', specialty: 'scout', venture: 'lantern-co' }), end('tool_use', { inputTokens: 100, outputTokens: 20 })],
    (req) => {
      const hire = JSON.parse(req.messages.at(-1).content[0].content);
      return [...toolCall('d1', 'delegate', { toAgentId: hire.agentId, brief: 'Find five shops.', budgetUsd: 1 }), end('tool_use', { inputTokens: 100, outputTokens: 20 })];
    },
    [text('Delegated.'), end()],
    [text('Noted.'), end()],
  ], { name: 'anthropic' });
  const makeProvider = async (name, opts) => (name === 'anthropic'
    ? { provider: chiefProvider, model: opts.model, price: { inputPerMTok: 4, outputPerMTok: 20 } }
    : { provider: fakeProvider([[text('Scouting… '), async () => new Promise((r) => setTimeout(r, 4000)), text('five shops found'), end()]], { name }), model: 'worker', price: null });
  // The first-run card (phase 3 step 3) is wired with a fake Ollama so the page shows it,
  // and completed through the API below so the rest of the check sees the park.
  const fakeOllama = await startFakeOllama({ models: [{ name: 'qwen2.5:7b', size: 4 * 1024 ** 3 }] });
  const srv = await startTestServer({ makeProvider, withChief: true, maxConcurrent: 3, ollama: fakeOllama.url, setup: { platform: 'linux' } });
  const { chrome, wsUrl, profile } = await launchChromium({ flags: BASE_FLAGS, extraFlags: WANT_WEBGPU ? WEBGPU_FLAGS : [] });
  const cdp = await connectCdp(wsUrl);
  const page = await openPage(cdp, srv.url + '/');
  const { evaluate, errors, logs, sessionId } = page;
  const statusText = () => evaluate("document.getElementById('status').textContent");
  for (let i = 0; i < 60; i++) {
    const t = await statusText();
    if (/ranger ready|ranger static|ranger missing|park: renderer/.test(t)) break;
    await wait(500);
  }
  console.log('status before mission:', await statusText());
  const firstRunShown = await evaluate("Boolean(document.querySelector('.firstrun')) && !document.querySelector('.firstrun-host').hidden");
  const firstRunSteps = await evaluate("[...document.querySelectorAll('.firstrun .fr-head')].map((n) => n.textContent)");
  console.log('first-run card:', firstRunShown ? 'shown' : 'NOT SHOWN', JSON.stringify(firstRunSteps));
  if (process.env.PARK_CHECK_SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await fsp.writeFile(process.env.PARK_CHECK_SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', process.env.PARK_CHECK_SHOT);
  }
  await srv.post('/api/setup/complete', { skipped: true });
  // Poll, never a fixed sleep: software GL draws the park at about a frame a second, and
  // the page needs a frame or two to hear the event and put the card away.
  const firstRunHidden = await until(() => evaluate("document.querySelector('.firstrun-host').hidden"), 15000);
  console.log('first-run card after skip:', firstRunHidden ? 'hidden' : 'STILL SHOWN');
  // Brief the Chief through the API; the page should show the crew grow and move.
  const r = await srv.post('/api/mission', { text: 'Sell paper lanterns online.', budgetUsd: 3, horizon: '30 days' });
  console.log('mission:', r.status, r.body.mission && r.body.mission.status);
  await srv.runs.waitForIdle();
  // Wait for the park to have a body for every agent rather than for a fixed moment: on
  // the WebGPU path the device can be lost and the whole park rebuilt here, and its
  // rigged bodies stream in again (the park renders while they do).
  const wantBodies = (await evaluate(`(async () => { const s = await (await fetch('/api/state')).json(); return s.layout.agents.length; })()`)) || 0;
  await until(async () => {
    const n = JSON.parse((await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().bodies()) : "[]"')) || '[]').length;
    return n >= wantBodies;
  }, 30000);
  const bodiesBefore = await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().bodies()) : null');
  console.log('bodies after mission:', bodiesBefore);
  const summary = await evaluate(`(async () => { const r = await fetch('/api/state'); const s = await r.json(); return { agents: s.layout.agents.map((a) => a.id + ':' + (a.role || 'ranger')), rooms: s.layout.rooms.map((r) => r.id), work: s.work.recent.map((w) => w.status), plan: s.mission.plan && s.mission.plan.version }; })()`);
  console.log('state after mission:', JSON.stringify(summary));
  console.log('status after mission:', await statusText());
  const bodies = JSON.parse((await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().bodies()) : "[]"')) || '[]');
  console.log('bodies:', JSON.stringify(bodies));
  // Navigation (D167): the movement keys walk the view, typing into a brief never does,
  // and the Jump to menu puts the camera at the place it names. Without this a broken
  // key listener is invisible until somebody tries to drive the park by hand.
  const camera = async () => JSON.parse((await evaluate('window.maka && window.maka.park() && window.maka.park().camera ? JSON.stringify(window.maka.park().camera()) : "null"')) || 'null');
  const moved = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0);
  // Everything here waits for the camera to arrive, never for a stopwatch: software GL
  // draws about a frame a second, and the walk and the jump both advance per frame.
  const camStart = await camera();
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }))");
  const walkDist = await until(async () => {
    const d = moved(camStart, await camera());
    return d > 2 ? d : 0;
  }, 15000);
  await evaluate("window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w' }))");
  // The key is up: whatever the camera does next, it is not this key.
  await wait(1200);
  const camBeforeTyping = await camera();
  await evaluate(`(() => { const t = document.querySelector('textarea.prompt'); if (!t) return false; t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true })); return true; })()`);
  await wait(1500);
  const typingDist = moved(camBeforeTyping, await camera());
  const places = JSON.parse((await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().places()) : "[]"')) || '[]');
  const peak = places.find((p) => p.kind === 'peak');
  if (peak) await evaluate(`window.maka.park().focus(${JSON.stringify(peak)})`);
  const jumpedNear = peak
    ? await until(async () => {
        const c = await camera();
        const d = c ? Math.hypot(c.target.x - peak.x, c.target.z - peak.z) : Infinity;
        return d < 3 ? d : 0;
      }, 20000).then((d) => (d === 0 ? Infinity : d))
    : Infinity;
  const navOk = walkDist > 2 && typingDist < 0.01 && Boolean(peak) && jumpedNear < 3;
  console.log(`navigation: walk moved ${walkDist.toFixed(1)} units, typing moved ${typingDist.toFixed(3)}, jump landed ${jumpedNear.toFixed(1)} from the Peak, ${places.length} places`, navOk ? 'OK' : 'NOT OK');

  // D192: the "Needs you" panel. It answers the question the park is asked most, so a
  // broken render here means the owner cannot see that the park is waiting on them.
  const attention = JSON.parse((await evaluate(`(() => {
    const w = document.querySelector('#attention');
    if (!w) return JSON.stringify({ missing: true });
    return JSON.stringify({
      title: (w.querySelector('.win-title') || {}).textContent || '',
      clear: Boolean(w.querySelector('.at-clear')),
      cards: w.querySelectorAll('.at-card').length,
      sections: [...w.querySelectorAll('.at-sec-head')].map((n) => n.textContent),
      rows: [...w.querySelectorAll('.at-row')].map((r) => [...r.children].map((c) => c.textContent).join(' = ')),
      hasWaiting: w.classList.contains('has-waiting'),
    });
  })()`)) || '{}');
  if (attention.missing) console.log('needs-you panel: MISSING');
  else {
    console.log(`needs-you panel: "${attention.title}" · ${attention.cards} card(s) · waiting=${attention.hasWaiting} · clear-state=${attention.clear}`);
    console.log(`needs-you sections: ${JSON.stringify(attention.sections)}`);
    for (const r of attention.rows.slice(0, 8)) console.log(`  ${r}`);
  }
  const attentionOk = Boolean(!attention.missing && attention.sections.length >= 2 && attention.rows.length >= 2);
  console.log('needs-you panel:', attentionOk ? 'OK' : 'NOT OK');

  // D187: Park Mail opens on I, shows a mailbox per department with its folders, closes on
  // Escape, and never swallows the park's own keys while it is shut. A mail client that
  // only works when someone is looking at it is not a mail client.
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i' }))");
  const mail = await until(async () => {
    const out = await evaluate(`(() => {
      const mb = document.querySelector('.mailbox');
      if (!mb || mb.hidden) return '';
      // Wait for the first load to have drawn, not merely for the panel to be visible.
      if (!mb.querySelector('.mb-folder')) return '';
      return JSON.stringify({
        open: true,
        stations: [...mb.querySelectorAll('.mb-station-name')].map((n) => n.textContent),
        folders: [...mb.querySelectorAll('.mb-folder span:first-child')].map((n) => n.textContent),
        status: (mb.querySelector('.mb-status') || {}).textContent || '',
        keys: mb.querySelectorAll('.mb-key').length,
        composeDisabled: (mb.querySelector('.mb-btn.primary') || {}).disabled === true,
        // D188: the parts that make it a mail client rather than a viewer.
        ticks: mb.querySelectorAll('.mb-tick').length,
        rows: mb.querySelectorAll('.mb-row').length,
        hasSnippetSlot: Boolean(mb.querySelector('.mb-row-open')),
      });
    })()`);
    return out && out !== '""' ? JSON.parse(JSON.parse(JSON.stringify(out))) : 0;
  }, 10000).catch(() => null);
  if (mail && mail.open) {
    console.log(`park mail: ${mail.stations.length} mailbox(es) [${mail.stations.slice(0, 4).join(', ')}…], folders [${mail.folders.join(', ')}], ${mail.keys} keys listed`);
    console.log(`park mail status line: ${JSON.stringify(mail.status)}`);
    console.log(`park mail compose disabled without a provider key: ${mail.composeDisabled}`);
    console.log(`park mail rows: ${mail.rows}, tick boxes: ${mail.ticks}, row layout: ${mail.hasSnippetSlot ? 'present' : 'missing'}`);
  }
  await evaluate("document.querySelector('.mailbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  const closed = await until(async () => ((await evaluate("document.querySelector('.mailbox').hidden ? '1' : ''")) ? 1 : 0), 6000).catch(() => 0);
  // D188: eight folders now (Spam joined), and a tick box on every row.
  const mailOk = Boolean(mail && mail.open && mail.folders.length === 8 && mail.stations.length >= 1 && mail.ticks === mail.rows && closed);
  console.log('park mail:', mailOk ? 'OK' : 'NOT OK');

  console.log('console errors:', errors.length ? errors : 'none');
  if (logs.length) console.log('console logs:', logs.slice(0, 10));
  const finalStatus = await statusText();
  const statsJson = await evaluate('window.maka && window.maka.park() ? JSON.stringify(window.maka.park().frameStats()) : null');
  const stats = statsJson ? JSON.parse(statsJson) : null;
  console.log('frame stats:', statsJson);
  // The label may carry the fallback's reason in parentheses: "webgl2 (no WebGPU adapter)".
  // With --webgpu the check passes in two honest ways: WebGPU drew the park (the status line
  // says `webgpu` and frames had draw calls), or the device was lost at the first present
  // (headless Chromium's software WebGPU cannot present to a canvas) and the park restarted
  // on WebGL2 saying so; the errors the lost device produced are then expected and listed.
  // The loss also cascades as "GPUValidationError ... due to a previous error" on some
  // Chromes (macOS): consequences of the same loss, expected on the device-lost path only.
  const lostErrors = errors.filter((e) => /Device Lost|Instance dropped|Instance reference no longer exists|GPUValidationError[\s\S]*due to a previous error/.test(e));
  const otherErrors = errors.filter((e) => !lostErrors.includes(e));
  let rendererOk;
  let unexpectedErrors = errors;
  if (!WANT_WEBGPU) {
    rendererOk = /park: webgl2( \([^)]*\))? ·/.test(finalStatus);
    console.log('renderer: webgl2 wanted', rendererOk ? 'OK' : 'NOT AS WANTED');
  } else if (/park: webgpu ·/.test(finalStatus)) {
    rendererOk = Boolean(stats && stats.calls > 0);
    console.log('renderer: webgpu drew the park', rendererOk ? `OK (${stats.calls} draw calls)` : 'NOT OK (no draw calls)');
  } else if (/park: webgl2 \(WebGPU device lost\) ·/.test(finalStatus)) {
    rendererOk = true;
    unexpectedErrors = otherErrors;
    console.log(`renderer: WebGPU started, the device was lost at the first present and the park restarted on WebGL2 (${lostErrors.length} errors from the lost device, expected). This Chromium cannot present WebGPU headless; the Mac verifies a WebGPU frame (docs/RELEASE_RUNBOOK.md).`);
  } else {
    rendererOk = false;
    console.log('renderer: webgpu wanted NOT AS WANTED');
  }
  if (unexpectedErrors !== errors) console.log('console errors (unexpected):', unexpectedErrors.length ? unexpectedErrors : 'none');
  const ok = unexpectedErrors.length === 0 && navOk && /ranger (ready|static)/.test(finalStatus) && rendererOk && bodies.length === summary.agents.length && bodies.some((b) => b.role === 'chief_ranger') && firstRunShown && firstRunSteps.length === 4 && firstRunHidden;
  // Cleanup never decides the verdict: the check passed or failed above.
  cdp.close();
  await stopChromium(chrome);
  await srv.close();
  await fakeOllama.close();
  await removeWithRetry(profile);
  console.log(ok ? 'PARK CHECK OK' : 'PARK CHECK FAILED');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
