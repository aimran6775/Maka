#!/usr/bin/env node
// `node scripts/release-node.mjs [--triple aarch64-apple-darwin] [--node-version 22.22.0]`:
// downloads the official Node binary for the target from nodejs.org, verifies it against
// SHASUMS256.txt, and writes src-tauri/binaries/node-<triple> (gitignored), which Tauri
// bundles as the sidecar's runtime (externalBin). Records what it fetched in
// src-tauri/binaries/node-<triple>.json for the runbook and NOTICE.
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, fetchNode, DEFAULT_TRIPLE, NODE_VERSION, REPO_ROOT } from './release-lib.mjs';

export async function bundleNode({ root = REPO_ROOT, triple = DEFAULT_TRIPLE, version = NODE_VERSION, baseUrl, fetch: fetchImpl, log = console } = {}) {
  const dest = path.join(root, 'src-tauri', 'binaries', `node-${triple}`);
  const r = await fetchNode({ version, triple, dest, baseUrl, fetch: fetchImpl, log });
  await fsp.writeFile(`${dest}.json`, JSON.stringify({ node: r.version, triple, file: r.file, sha256: r.sha256, bytes: r.bytes, source: r.source, license: 'MIT (https://github.com/nodejs/node/blob/main/LICENSE)' }, null, 2) + '\n');
  log.info(`bundled Node ${r.version} for ${triple} at ${dest} (${r.bytes} bytes, archive sha256 ${r.sha256})`);
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseArgs(process.argv.slice(2));
  bundleNode({ root: flags.root ? path.resolve(flags.root) : REPO_ROOT, triple: flags.triple || DEFAULT_TRIPLE, version: flags['node-version'] || NODE_VERSION }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
