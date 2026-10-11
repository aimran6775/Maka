// The orphan watch (sidecar/orphan.js): under the macOS shell (MAKA_SHELL=tauri) a
// sidecar whose shell died is reparented and must exit — seen on the Mac when tauri
// dev's rebuild SIGKILLed the shell and the orphaned sidecar held the port, crash-looping
// the next instance on EADDRINUSE. Without MAKA_SHELL nothing watches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startOrphanWatch } from '../sidecar/orphan.js';

const quiet = { error: () => {} };

test('no watch without the shell: npm start owns itself', () => {
  assert.equal(startOrphanWatch({ env: {}, intervalMs: 5, log: quiet }), null);
  assert.equal(startOrphanWatch({ env: { MAKA_SHELL: '' }, intervalMs: 5, log: quiet }), null);
});

test('under the shell: a stable parent keeps the sidecar alive, a reparent exits it with the reason logged', async () => {
  let ppid = 4242;
  let exited = null;
  const lines = [];
  const timer = startOrphanWatch({
    env: { MAKA_SHELL: 'tauri' },
    getppid: () => ppid,
    exit: (code) => { exited = code; },
    log: { error: (msg) => lines.push(msg) },
    intervalMs: 5,
  });
  assert.ok(timer, 'the watch runs under the shell');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(exited, null, 'the parent lives, so the sidecar does');
  ppid = 1; // the shell is gone: launchd adopted the sidecar
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(exited, 0);
  assert.match(lines.join('\n'), /pid 4242.*gone.*reparented to 1/);
  clearInterval(timer);
});
