#!/usr/bin/env node
// `npm run shell:check`: type-checks the Tauri shell for Apple Silicon from any host.
// A check links nothing, so it works from Linux with the aarch64-apple-darwin std
// installed (`rustup target add aarch64-apple-darwin`). DOCS_RS=1 makes the
// Objective-C exception helper skip its clang step (its own docs.rs escape hatch); the
// `externalBin` placeholder stands in for the Node binary the release script downloads.
// On a Mac, `cargo test` in src-tauri/ runs the unit tests as well.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shell = path.join(root, 'src-tauri');
const target = process.env.MAKA_SHELL_TARGET || 'aarch64-apple-darwin';
const placeholder = path.join(shell, 'binaries', `node-${target}`);
if (!existsSync(placeholder)) {
  mkdirSync(path.dirname(placeholder), { recursive: true });
  writeFileSync(placeholder, '#!/bin/sh\necho "placeholder for the Node binary scripts/release-build.mjs downloads" >&2\nexit 1\n');
  console.log(`wrote placeholder ${path.relative(root, placeholder)} (gitignored)`);
}
const args = ['check', '--target', target, ...process.argv.slice(2)];
console.log(`cargo ${args.join(' ')} (in src-tauri/, DOCS_RS=1)`);
const r = spawnSync('cargo', args, { cwd: shell, stdio: 'inherit', env: { ...process.env, DOCS_RS: '1' } });
process.exit(r.status ?? 1);
