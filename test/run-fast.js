// Runs the suites listed in test/fast.list with `node --test`.
// Exit code is node's: non-zero when any listed suite fails or is missing. Also fails when a
// `test/*.test.js` file exists that fast.list does not name, so a suite cannot slip out of
// the merge gate by omission (list it, or rename it off `.test.js` on purpose).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listPath = path.join(root, 'test', 'fast.list');
const files = readFileSync(listPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const missing = files.filter((f) => !existsSync(path.join(root, f)));
if (missing.length) {
  console.error(`fast.list names files that do not exist:\n  ${missing.join('\n  ')}`);
  process.exit(2);
}
if (!files.length) {
  console.error('fast.list is empty');
  process.exit(2);
}
const onDisk = readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`);
const unlisted = onDisk.filter((f) => !files.includes(f));
if (unlisted.length) {
  console.error(`test suites exist that fast.list does not name:\n  ${unlisted.join('\n  ')}`);
  process.exit(2);
}

// --test-force-exit: a failing test that leaves a child process or socket open must fail
// the gate, not hang it (seen on macOS: a thrown assertion skipped a client.close()).
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
