// Runs the suites listed in test/fast.list with `node --test`.
// Exit code is node's: non-zero when any listed suite fails or is missing.
import { readFileSync, existsSync } from 'node:fs';
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

const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
